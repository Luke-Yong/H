import { useState, useCallback, useMemo } from "react";
import { VFile, createFile, detectLanguage } from "./fileModel";
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
  onAdd: () => void;
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
}

const FILE_ICONS: Record<string, string> = {
  html: "🟠", css: "🔵", javascript: "🟡", typescript: "🔷",
  json: "🟢", markdown: "📘", python: "🐍", default: "📄",
};

function statusColor(s: string): string {
  if (s === "M") return "#e2b714";
  if (s === "A") return "#4ec94e";
  if (s === "D") return "#f44747";
  if (s === "U" || s === "?") return "#569cd6";
  return "#e2b714";
}

function FsTree({ entries, basePath, onOpenFile, onOpenFolder, depth, gitChanges }: {
  entries: FsEntry[];
  basePath: string;
  onOpenFile: (p: string, h?: FileSystemFileHandle) => void;
  onOpenFolder: (p: string) => void;
  depth: number;
  gitChanges?: Map<string, string>;
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
        />
      ))}
    </>
  );
}

function hasDescendantChanges(dirPath: string, changes: Map<string, string>): string | null {
  const prefix = (dirPath.endsWith("/") ? dirPath : dirPath + "/").replace(/\\/g, "/");
  // Priority: M > A > D > U
  let best: string | null = null;
  const prio: Record<string, number> = { "M": 4, "A": 3, "D": 2, "U": 1, "?": 0 };
  for (const [filePath, status] of changes) {
    const fp = filePath.replace(/\\/g, "/");
    if (!fp.startsWith(prefix)) continue;
    if (!best || (prio[status] || 0) > (prio[best] || 0)) best = status;
  }
  return best;
}

function FsNode({ entry, basePath, onOpenFile, onOpenFolder, depth, gitChanges }: {
  entry: FsEntry;
  basePath: string;
  onOpenFile: (p: string, h?: FileSystemFileHandle) => void;
  onOpenFolder: (p: string) => void;
  depth: number;
  gitChanges?: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const gitMarker = useMemo(() => {
    if (!gitChanges || gitChanges.size === 0) return null;
    if (entry.isDirectory) {
      return hasDescendantChanges(entry.path, gitChanges);
    }
    return gitChanges.get(entry.path.replace(/\\/g, "/")) || null;
  }, [entry, gitChanges]);

  const handleToggle = useCallback(async () => {
    if (entry.isDirectory) {
      if (children === null) {
        setExpanded(true);
        setLoading(true);
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
      } else {
        setExpanded(!expanded);
      }
    } else {
      onOpenFile(entry.path, entry._handle as FileSystemFileHandle | undefined);
    }
  }, [entry, children, expanded]);

  const icon = entry.isDirectory ? (expanded ? "📂" : "📁") : "📄";

  return (
    <>
      <div
        className="fs-tree-item"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleToggle}
      >
        <span className="file-icon">
          {loading ? "⏳" : icon}
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
        />
      )}
    </>
  );
}

export default function FilesPanel({
  files, activeFileId, onSelect, onAdd, onDelete, onRename,
  fsRoot, fsBasePath, onOpenFsFile, onRefreshFs,
  width, gitChanges,
}: Props) {
  return (
    <div className="files-panel" style={width ? { width, minWidth: width } : {}}>
      {fsRoot ? (
        <>
          <div className="files-header">
            <span>{fsBasePath ? fsBasePath.split(/[/\\]/).pop() || "FOLDER" : "FOLDER"}</span>
            <div className="files-header-actions">
              <button className="files-add-btn" onClick={onRefreshFs} title="Refresh">↻</button>
              <button className="files-add-btn" onClick={onAdd} title="New file">+</button>
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
            />
          </div>
        </>
      ) : (
        <>
          <div className="files-header">
            <span>FILES</span>
            <div className="files-header-actions">
              <button className="files-add-btn" onClick={onAdd} title="New file">+</button>
            </div>
          </div>
          <div className="files-list">
            {files.map((f) => {
              const icon = FILE_ICONS[f.language] || FILE_ICONS.default;
              return (
                <div
                  key={f.id}
                  className={`file-item${f.id === activeFileId ? " active" : ""}`}
                  onClick={() => onSelect(f.id)}
                >
                  <span className="file-icon">{icon}</span>
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
    </div>
  );
}
