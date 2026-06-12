import { useState, forwardRef, useImperativeHandle, useCallback, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import FilesPanel from "./FilesPanel";
import BrowserView from "./BrowserView";
import TerminalPane from "./TerminalPane";
import { VFile, createFile, detectLanguage } from "./fileModel";
import { readFileFromHandle, writeFileToHandle } from "./browserFs";
import { useResizable, ResizeHandle } from "../hooks/useResizable";
import type { FsEntry } from "./FilesPanel";

interface BrowserTab {
  id: string;
  url: string;
  label: string; // short display name for the tab
}

export interface EditorPaneHandle {
  getCode: () => { html: string; css: string; js: string };
  getFiles: () => VFile[];
  applyAiFiles: (files: { name: string; content: string }[]) => void;
}

interface Props {
  fsRoot: FsEntry[] | null;
  fsBasePath: string;
  terminalVenvDir: string;
  terminalActivateScript: string;
  browserTabs: BrowserTab[];
  onBrowserTabClose: (id: string) => void;
  onAddBrowserTab: () => void;
  onOpenFolder: () => void;
  onCreateProject: () => void;
  onCreateFile: () => void;
  onOpenFile: () => void;
  onRefreshFs: () => void;
  terminalVisible: boolean;
  onCloseTerminal: () => void;
  onDetectUrl?: (sessionId: string, url: string) => void;
}

const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { fsRoot, fsBasePath, terminalVenvDir, terminalActivateScript, browserTabs, onBrowserTabClose, onAddBrowserTab,
    onOpenFolder, onCreateProject, onCreateFile, onOpenFile, onRefreshFs,
    terminalVisible, onCloseTerminal, onDetectUrl }, ref
) {
  const [files, setFiles] = useState<VFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string>("");
  const activeFileIdRef = useRef(activeFileId);
  const { size: filePanelW, onMouseDown: onFilePanelDrag } = useResizable(200, 120, 500);
  const { size: termH, onMouseDown: onTermDrag } = useResizable(220, 80, 600, true);

  const hasBrowserTabs = browserTabs.length > 0;
  const hasContent = files.length > 0 || (fsRoot && fsRoot.length > 0) || hasBrowserTabs;
  const activeBrowserTab = browserTabs.find((b) => b.id === activeFileId);

  useEffect(() => { activeFileIdRef.current = activeFileId; }, [activeFileId]);

  // Auto-select newest browser tab when one is added (auto-detect or manual +)
  const prevBrowserCount = useRef(0);
  useEffect(() => {
    if (browserTabs.length > prevBrowserCount.current && browserTabs.length > 0) {
      setActiveFileId(browserTabs[browserTabs.length - 1].id);
    }
    prevBrowserCount.current = browserTabs.length;
  }, [browserTabs]);

  const getCode = useCallback(() => {
    const byExt = (ext: string) => files.find((f) => f.name.endsWith(ext))?.content || "";
    return { html: byExt(".html"), css: byExt(".css"), js: byExt(".js") };
  }, [files]);

  const openFsFile = useCallback(async (filePath: string, handle?: FileSystemFileHandle) => {
    const existing = files.find((f) => f._fsPath === filePath);
    if (existing) { setActiveFileId(existing.id); return; }
    try {
      const name = filePath.split(/[/\\]/).pop() || "untitled";
      if (handle) {
        const content = await readFileFromHandle(handle);
        const f = createFile(name, content);
        f._fsPath = filePath; f._fsHandle = handle;
        setFiles((prev) => [...prev, f]);
        setActiveFileId(f.id);
      } else {
        const res = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        const f = createFile(name, data.content);
        f._fsPath = filePath;
        setFiles((prev) => [...prev, f]);
        setActiveFileId(f.id);
      }
    } catch (err) { console.error("Failed to open file:", err); }
  }, [files]);

  const applyAiFiles = useCallback((aiFiles: { name: string; content: string }[]) => {
    let newFileId = "";
    setFiles((prev) => {
      const updated = [...prev];
      for (const af of aiFiles) {
        const existing = updated.find((f) => f.name === af.name);
        if (existing) {
          existing.content = af.content;
          if (existing._fsPath) {
            fetch("/api/fs/write", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: existing._fsPath, content: af.content }),
            }).catch(() => {});
          }
        } else {
          const f = createFile(af.name, af.content);
          updated.push(f);
          newFileId = newFileId || f.id;
        }
      }
      return updated;
    });
    if (newFileId) setActiveFileId(newFileId);
  }, []);

  useImperativeHandle(ref, () => ({ getCode, getFiles: () => files, applyAiFiles }), [getCode, files, applyAiFiles]);

  const updateFile = useCallback((id: string, content: string) => {
    setFiles((prev) => prev.map((f) => {
      if (f.id !== id) return f;
      if (f._fsHandle) writeFileToHandle(f._fsHandle, content).catch(() => {});
      else if (f._fsPath) {
        fetch("/api/fs/write", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: f._fsPath, content }),
        }).catch(() => {});
      }
      return { ...f, content };
    }));
  }, []);

  const addFile = useCallback(() => {
    const name = prompt("File name (e.g. utils.js):");
    if (!name) return;
    setFiles((prev) => [...prev, createFile(name)]);
  }, []);

  const closeTab = useCallback((id: string) => {
    // Browser tab
    if (browserTabs.some((b) => b.id === id)) {
      onBrowserTabClose(id);
      if (activeFileIdRef.current === id) setActiveFileId(files[0]?.id || "");
      return;
    }
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      const remaining = prev.filter((f) => f.id !== id);
      if (activeFileIdRef.current === id) {
        const next = remaining[Math.min(Math.max(idx, 0), Math.max(0, remaining.length - 1))];
        setActiveFileId(next?.id || "");
      } else if (activeFileIdRef.current && !remaining.some((f) => f.id === activeFileIdRef.current)) {
        setActiveFileId(remaining[0]?.id || "");
      }
      return remaining;
    });
  }, [browserTabs, files, onBrowserTabClose]);

  const renameFile = useCallback((id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    const newName = prompt("New name:", f.name);
    if (!newName || newName === f.name) return;
    setFiles((prev) => prev.map((x) =>
      x.id === id ? { ...x, name: newName, language: detectLanguage(newName) } : x
    ));
  }, [files]);

  if (!hasContent && !terminalVisible) {
    return (
      <div className="ide-layout">
        <div className="editor-welcome">
          <div className="welcome-logo">Harness</div>
          <div className="welcome-subtitle">AI-Powered Browser Test IDE</div>
          <div className="welcome-actions">
            <button className="welcome-btn" onClick={onOpenFolder}>
              <span className="welcome-btn-icon">📂</span>
              <span className="welcome-btn-text"><strong>Open Folder</strong><small>Open an existing project from your drive</small></span>
            </button>
            <button className="welcome-btn" onClick={onOpenFile}>
              <span className="welcome-btn-icon">📄</span>
              <span className="welcome-btn-text"><strong>Open File</strong><small>Open a single file from your drive</small></span>
            </button>
            <button className="welcome-btn" onClick={onCreateProject}>
              <span className="welcome-btn-icon">🆕</span>
              <span className="welcome-btn-text"><strong>New Project</strong><small>Create a new folder with index.html, style.css, app.js</small></span>
            </button>
            <button className="welcome-btn" onClick={onCreateFile}>
              <span className="welcome-btn-icon">📝</span>
              <span className="welcome-btn-text"><strong>New File</strong><small>Create a new file in the current folder</small></span>
            </button>
          </div>
          <div className="welcome-shortcuts">
            <span>Ctrl+K Ctrl+O — Open Folder</span>
            <span>Ctrl+O — Open File</span>
            <span>Ctrl+N — New File</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ide-layout">
      <FilesPanel
        files={files}
        activeFileId={activeFileId}
        onSelect={setActiveFileId}
        onAdd={addFile}
        onDelete={(id) => closeTab(id)}
        onRename={renameFile}
        fsRoot={fsRoot}
        fsBasePath={fsBasePath}
        onOpenFsFile={openFsFile}
        onOpenFsFolder={onOpenFolder}
        onRefreshFs={onRefreshFs}
        width={filePanelW}
      />
      <ResizeHandle onMouseDown={onFilePanelDrag} />
      <div className="ide-editor-area">
        <div className="editor-tabs">
          {files.length === 0 && !hasBrowserTabs && (
            <div className="editor-tab tab-hint">Open a file from the sidebar to begin</div>
          )}
          {files.map((f) => (
            <button key={f.id} className={`editor-tab${f.id === activeFileId ? " active" : ""}`} onClick={() => setActiveFileId(f.id)}>
              {f._fsPath && <span className="tab-dot" title="On disk">● </span>}{f.name}
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(f.id); }}>✕</span>
            </button>
          ))}
          {browserTabs.map((b) => (
            <button key={b.id} className={`editor-tab${b.id === activeFileId ? " active" : ""}`} onClick={() => setActiveFileId(b.id)}>
              🌐 {b.label}
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(b.id); }}>✕</span>
            </button>
          ))}
          <button className="editor-tab editor-tab-add" onClick={onAddBrowserTab} title="New browser tab">+ 🌐</button>
        </div>
        <div className="editor-main" style={terminalVisible ? { height: `calc(100% - ${termH}px - 4px)` } : { flex: 1 }}>
          <div className="editor-container">
            {files.length === 0 && !hasBrowserTabs && (
              <div className="editor-empty">
                <p>Select a file</p>
              </div>
            )}
            {activeBrowserTab && (
              <div style={{ height: "100%" }}><BrowserView url={activeBrowserTab.url} /></div>
            )}
            {files.map((f) => (
              <div key={f.id} style={{ display: f.id === activeFileId ? "flex" : "none", height: "100%" }}>
                <Editor
                  height="100%" language={f.language} theme="vs-dark"
                  value={f.content} onChange={(val) => updateFile(f.id, val || "")}
                  options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, lineNumbers: "on", renderWhitespace: "selection" }}
                />
              </div>
            ))}
          </div>
        </div>
        {terminalVisible && (
          <>
            <div className="resize-handle-v" onMouseDown={onTermDrag} />
            <div className="terminal-inline" style={{ height: termH }}>
              <TerminalPane
                visible={true}
                onClose={onCloseTerminal}
                cwd={fsBasePath}
                venvDir={terminalVenvDir}
                activateScript={terminalActivateScript}
                onDetectUrl={onDetectUrl}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
});

export default EditorPane;
