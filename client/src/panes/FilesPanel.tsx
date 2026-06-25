import { useState, useCallback, useMemo, useEffect } from "react";
import { VFile, fileIconUrl, folderIconUrl } from "./fileModel";
import { enumerateHandle } from "./browserFs";

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  _handle?: FileSystemDirectoryHandle | FileSystemFileHandle;
}

interface Props {
  files: VFile[];
  activeFileId: string | null;
  onSelect: (id: string) => void;
  onAdd: (parentDir?: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  /** File-system tree entries (from backend) */
  fsRoot: FsEntry[] | null;
  fsBasePath: string;
  onOpenFsFile: (filePath: string, handle?: FileSystemFileHandle) => void;
  onOpenFsFolder: (dirPath: string) => void;
  onRefreshFs: () => void;
  /** Resizable width */
  width?: number;
  /** Git change map: file path → status letter (M/A/D/U/?) */
  gitChanges?: Map<string, string>;
  /** Selected folder path (highlighted) — used when adding new files */
  selectedFolder: string | null;
  onSelectFolder: (path: string | null) => void;
  onFsDelete: (path: string) => void;
  onFsRename: (oldPath: string) => void;
  /** Path of the currently active editor file (for tree highlight). */
  activeFilePath: string | null;
}

function statusColor(s: string): string {
  if (s === "M") return "#e2b714";
  if (s === "A") return "#4ec94e";
  if (s === "D") return "#f44747";
  if (s === "U" || s === "?") return "#569cd6";
  return "#e2b714";
}

function FsTree({ entries, basePath, onOpenFile, onOpenFolder, depth, gitChanges, selectedFolder, onSelectFolder, onContextMenu, activeFilePath }: {
  entries: FsEntry[];
  basePath: string;
  onOpenFile: (p: string, h?: FileSystemFileHandle) => void;
  onOpenFolder: (p: string) => void;
  depth: number;
  gitChanges?: Map<string, string>;
  selectedFolder: string | null;
  onSelectFolder: (path: string | null) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  activeFilePath: string | null;
}) {
  return (
    <>
      {entries.map((entry) => (
        <FsNode
          key={entry.path}
          entry={entry}
          basePath={basePath}
          onOpenFile={onOpenFile}
          onOpenFolder={onOpenFolder}
          depth={depth}
          gitChanges={gitChanges}
          selectedFolder={selectedFolder}
          onSelectFolder={onSelectFolder}
          onContextMenu={onContextMenu}
          activeFilePath={activeFilePath}
        />
      ))}
    </>
  );
}

// Normalize a path for comparison: unify separators + uppercase drive letter
// (must match the key normalization used when the git-change map is built).
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, (_m, d) => d.toUpperCase() + ":");
}

function hasDescendantChanges(dirPath: string, changes: Map<string, string>): string | null {
  const norm = normPath(dirPath);
  const prefix = norm.endsWith("/") ? norm : norm + "/";
  // Priority: M > A > D > U
  let best: string | null = null;
  const prio: Record<string, number> = { "M": 4, "A": 3, "D": 2, "U": 1, "?": 0 };
  for (const [filePath, status] of changes) {
    if (!normPath(filePath).startsWith(prefix)) continue;
    if (!best || (prio[status] || 0) > (prio[best] || 0)) best = status;
  }
  return best;
}

function FsNode({ entry, basePath, onOpenFile, onOpenFolder, depth, gitChanges, selectedFolder, onSelectFolder, onContextMenu, activeFilePath }: {
  entry: FsEntry;
  basePath: string;
  onOpenFile: (p: string, h?: FileSystemFileHandle) => void;
  onOpenFolder: (p: string) => void;
  depth: number;
  gitChanges?: Map<string, string>;
  selectedFolder: string | null;
  onSelectFolder: (path: string | null) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  activeFilePath: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const isSelected = selectedFolder === entry.path;
  const isActiveFile = activeFilePath ? normPath(entry.path) === normPath(activeFilePath) : false;
  // Is the active file under this directory? If so, auto-expand + highlight the folder.
  const containsActive = activeFilePath && entry.isDirectory
    ? normPath(activeFilePath).startsWith(normPath(entry.path) + "/")
    : false;

  // Auto-expand the folder that contains the active file.
  useEffect(() => {
    if (containsActive && children === null) {
      setExpanded(true);
      setLoading(true);
      // eager-fetch children so the file highlight is visible
      fetchChildren();
    }
  }, [containsActive, children]);

  const fetchChildren = async () => {
    try {
      if (entry._handle && entry._handle.kind === "directory") {
        setChildren(await enumerateHandle(entry._handle as FileSystemDirectoryHandle));
      } else {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(entry.path)}`);
        const data = await res.json();
        setChildren(data.entries || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const gitMarker = useMemo(() => {
    if (!gitChanges || gitChanges.size === 0) return null;
    if (entry.isDirectory) {
      return hasDescendantChanges(entry.path, gitChanges);
    }
    return gitChanges.get(normPath(entry.path)) || null;
  }, [entry, gitChanges]);

  const handleToggle = useCallback(async () => {
    if (entry.isDirectory) {
      // Select the folder (for adding files inside it)
      onSelectFolder(isSelected ? null : entry.path);
      if (children === null) {
        setExpanded(true);
        setLoading(true);
        fetchChildren();
      } else {
        setExpanded(!expanded);
      }
    } else {
      onOpenFile(entry.path, entry._handle as FileSystemFileHandle | undefined);
    }
  }, [entry, children, expanded, isSelected, onSelectFolder]);

  const handleContext = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, entry);
  }, [entry, onContextMenu]);

  const iconUrl = entry.isDirectory ? folderIconUrl(expanded) : fileIconUrl(entry.name);

  return (
    <>
      <div
        className={`fs-tree-item${isSelected ? " selected" : ""}${isActiveFile ? " active-file" : ""}${containsActive ? " contains-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleToggle}
        onContextMenu={handleContext}
      >
        <span className="file-icon">
          {loading ? "⏳" : <img className="file-icon-img" src={iconUrl} alt="" draggable={false} />}
        </span>
        <span className="file-name">{entry.name}</span>
        {gitMarker && (
          <span className="fs-git-marker" style={{ color: statusColor(gitMarker) }}>
            {gitMarker}
          </span>
        )}
      </div>
      {expanded && children && (
        <FsTree
          entries={children}
          basePath={basePath}
          onOpenFile={onOpenFile}
          onOpenFolder={onOpenFolder}
          depth={depth + 1}
          gitChanges={gitChanges}
          selectedFolder={selectedFolder}
          onSelectFolder={onSelectFolder}
          onContextMenu={onContextMenu}
          activeFilePath={activeFilePath}
        />
      )}
    </>
  );
}

export default function FilesPanel({
  files, activeFileId, onSelect, onAdd, onDelete, onRename,
  fsRoot, fsBasePath, onOpenFsFile, onRefreshFs,
  width, gitChanges,
  selectedFolder, onSelectFolder, onFsDelete, onFsRename,
  activeFilePath,
}: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FsEntry } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Close context menu on any mousedown outside (fires before click, so
  // our menu item onMouseDown handlers fire first).
  useEffect(() => {
    if (!contextMenu) return;
    const h = (e: MouseEvent) => {
      // Ignore if the click is on the menu itself
      const target = e.target as HTMLElement | null;
      if (target?.closest(".fs-context-menu")) return;
      closeContextMenu();
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [contextMenu, closeContextMenu]);

  return (
    <div className="files-panel" style={width ? { width, minWidth: width } : {}}>
      {fsRoot ? (
        <>
          <div className="files-header">
            <span>{fsBasePath ? fsBasePath.split(/[/\\]/).pop() || "FOLDER" : "FOLDER"}</span>
            <div className="files-header-actions">
              <button className="files-add-btn" onClick={onRefreshFs} title="Refresh">↻</button>
              <button className="files-add-btn" onClick={() => onAdd(selectedFolder || undefined)} title={selectedFolder ? `New file in ${selectedFolder.split(/[/\\]/).pop()}` : "New file"}>+</button>
            </div>
          </div>
          <div className="files-list">
            <FsTree
              entries={fsRoot}
              basePath={fsBasePath}
              onOpenFile={onOpenFsFile}
              onOpenFolder={() => {}}
              depth={0}
              gitChanges={gitChanges}
              selectedFolder={selectedFolder}
              onSelectFolder={onSelectFolder}
              onContextMenu={handleContextMenu}
              activeFilePath={activeFilePath}
            />
          </div>
        </>
      ) : (
        <>
          <div className="files-header">
            <span>FILES</span>
            <div className="files-header-actions">
              <button className="files-add-btn" onClick={() => onAdd()} title="New file">+</button>
            </div>
          </div>
          <div className="files-list">
            {files.map((f) => {
              return (
                <div
                  key={f.id}
                  className={`file-item${f.id === activeFileId ? " active" : ""}`}
                  onClick={() => onSelect(f.id)}
                >
                  <span className="file-icon"><img className="file-icon-img" src={fileIconUrl(f.name)} alt="" draggable={false} /></span>
                  <span className="file-name">{f.name}</span>
                  <span className="file-actions">
                    <button
                      className="file-action-btn"
                      onClick={(e) => { e.stopPropagation(); onRename(f.id); }}
                      title="Rename"
                    >✎</button>
                    <button
                      className="file-action-btn"
                      onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
                      title="Delete"
                    >✕</button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {/* Context menu (right-click on fs-tree item) */}
      {contextMenu && (
        <div
          className="fs-context-menu"
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="fs-context-item"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onFsRename(contextMenu.entry.path); closeContextMenu(); }}
          >Rename</button>
          <button
            className="fs-context-item fs-context-item-danger"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onFsDelete(contextMenu.entry.path); closeContextMenu(); }}
          >Delete</button>
        </div>
      )}
    </div>
  );
}
