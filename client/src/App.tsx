import { useRef, useCallback, useState } from "react";
import EditorPane, { EditorPaneHandle } from "./panes/EditorPane";
import TestConsole from "./panes/TestConsole";
import MenuBar from "./panes/MenuBar";
import PathDialog, { DialogResult } from "./panes/PathDialog";
import { useWebSocket } from "./hooks/useWebSocket";
import { useResizable, ResizeHandle } from "./hooks/useResizable";
import type { FsEntry } from "./panes/FilesPanel";

type DialogMode = "open-folder" | "open-file" | "new-project" | "new-file" | null;

export default function App() {
  const editorRef = useRef<EditorPaneHandle>(null);
  const { connected, events, runTest } = useWebSocket();

  const [fsRoot, setFsRoot] = useState<FsEntry[] | null>(null);
  const [fsBasePath, setFsBasePath] = useState("");
  const isBrowserFs = useRef(false);
  const [goal, setGoal] = useState("Verify the app works correctly");
  const [termVisible, setTermVisible] = useState(false);

  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [dialogDefault, setDialogDefault] = useState("");

  // Resizable console pane (width from right edge)
  const { size: consoleW, onMouseDown: onConsoleDrag } = useResizable(320, 200, 800, true);

  const openFolder = useCallback(async (folderPath: string) => {
    try {
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(folderPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFsRoot(data.entries || []);
      setFsBasePath(data.path);
      isBrowserFs.current = false;
    } catch (err) { alert(`Failed to open folder: ${err}`); }
  }, []);

  const createProject = useCallback(async (dir: string) => {
    try {
      await fetch("/api/fs/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir }) });
      const sep = dir.includes("/") ? "/" : "\\";
      await fetch("/api/fs/create-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir + sep + "index.html", content: `<!DOCTYPE html>\n<html>\n<head>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello</h1>\n  <script src="app.js"></script>\n</body>\n</html>` }) });
      await fetch("/api/fs/create-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir + sep + "style.css", content: "body {\n  font-family: sans-serif;\n  padding: 2rem;\n}" }) });
      await fetch("/api/fs/create-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir + sep + "app.js", content: "console.log('Hello Harness!');" }) });
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(dir)}`);
      const data = await res.json();
      setFsRoot(data.entries || []);
      setFsBasePath(data.path);
    } catch (err) { alert(`Failed to create project: ${err}`); }
  }, []);

  const createNewFile = useCallback(async (name: string) => {
    if (!fsBasePath) return;
    const filePath = fsBasePath + (fsBasePath.includes("/") ? "/" : "\\") + name;
    try { await fetch("/api/fs/create-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: filePath, content: "" }) }); await refreshFs(); }
    catch (err) { alert(`Failed to create file: ${err}`); }
  }, [fsBasePath]);

  const openFileByPath = useCallback(async (filePath: string) => {
    try {
      const res = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      editorRef.current?.applyAiFiles([{ name: filePath.split(/[/\\]/).pop() || "untitled", content: data.content }]);
    } catch (err) { alert(`Failed to open file: ${err}`); }
  }, []);

  const refreshFs = useCallback(async () => {
    if (isBrowserFs.current || !fsBasePath) return;
    try { const res = await fetch(`/api/fs/list?path=${encodeURIComponent(fsBasePath)}`); const data = await res.json(); setFsRoot(data.entries || []); }
    catch { /* ignore */ }
  }, [fsBasePath]);

  const handleDialogOk = useCallback((result: DialogResult) => {
    setDialogMode(null);
    if (dialogMode === "open-folder") {
      if (result.entries) { setFsRoot(result.entries); setFsBasePath(result.path); isBrowserFs.current = true; return; }
      if (result.path.trim()) openFolder(result.path);
    } else if (dialogMode === "open-file") {
      if (result.fileData) {
        const file = result.fileData;
        editorRef.current?.applyAiFiles([{ name: file.name, content: file.content }]);
        const files = editorRef.current?.getFiles() || [];
        const last = files[files.length - 1];
        if (last) last._fsHandle = file.handle;
        return;
      }
      if (result.path.trim()) openFileByPath(result.path);
    } else if (dialogMode === "new-project") {
      if (result.path.trim()) createProject(result.path);
    } else if (dialogMode === "new-file") {
      if (result.path.trim()) createNewFile(result.path);
    }
  }, [dialogMode, openFolder, openFileByPath, createProject, createNewFile]);

  const showDialog = useCallback((mode: "open-folder" | "open-file" | "new-project" | "new-file", defaultValue = "") => {
    setDialogDefault(defaultValue); setDialogMode(mode);
  }, []);

  const handleRun = useCallback(() => {
    const code = editorRef.current?.getCode();
    if (!code) return;
    runTest({ html: code.html, css: code.css, js: code.js, goal, maxSteps: 10 });
  }, [runTest, goal]);

  const menus = [
    {
      label: "File",
      items: [
        { label: "Open Folder...", shortcut: "Ctrl+K Ctrl+O", action: () => showDialog("open-folder") },
        { label: "Open File...", shortcut: "Ctrl+O", action: () => showDialog("open-file") },
        "---" as const,
        { label: "New Project...", action: () => showDialog("new-project") },
        { label: "New File", shortcut: "Ctrl+N", action: () => showDialog("new-file") },
        "---" as const,
        { label: "Save", shortcut: "Ctrl+S", action: () => {
          const files = editorRef.current?.getFiles(); if (files) for (const f of files) { if (f._fsPath) fetch("/api/fs/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: f._fsPath, content: f.content }) }).catch(() => {}); }
        }},
        "---" as const,
        { label: "Close Folder", shortcut: "Ctrl+K F", action: () => { setFsRoot(null); setFsBasePath(""); isBrowserFs.current = false; } },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "Ctrl+Z", action: () => document.execCommand("undo") },
        { label: "Redo", shortcut: "Ctrl+Y", action: () => document.execCommand("redo") },
        "---" as const,
        { label: "Cut", shortcut: "Ctrl+X", action: () => document.execCommand("cut") },
        { label: "Copy", shortcut: "Ctrl+C", action: () => document.execCommand("copy") },
        { label: "Paste", shortcut: "Ctrl+V", action: () => document.execCommand("paste") },
        "---" as const,
        { label: "Find", shortcut: "Ctrl+F", action: () => (document.querySelector(".monaco-editor textarea") as HTMLElement)?.focus() },
        { label: "Replace", shortcut: "Ctrl+H", action: () => (document.querySelector(".monaco-editor textarea") as HTMLElement)?.focus() },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Toggle Console", shortcut: "Ctrl+J", action: () => { const p = document.querySelector(".pane-console") as HTMLElement; if (p) p.style.display = p.style.display === "none" ? "" : "none"; } },
      ],
    },
    {
      label: "Terminal",
      items: [
        { label: "New Terminal", shortcut: "Ctrl+`", action: () => setTermVisible(true) },
        { label: "Kill Terminal", action: () => setTermVisible(false) },
      ],
    },
    { label: "Help", items: [{ label: "About Harness", action: () => alert("Harness - AI-powered browser test runner\nMonaco + Playwright + DeepSeek") }] },
  ];

  const dialogProps: Record<string, { title: string; placeholder: string; browseDir: boolean; okLabel: string }> = {
    "open-folder": { title: "Open Folder", placeholder: "e.g. D:/my-project", browseDir: true, okLabel: "Open Folder" },
    "open-file":   { title: "Open File",   placeholder: "e.g. D:/project/app.js", browseDir: false, okLabel: "Open File" },
    "new-project": { title: "New Project", placeholder: "e.g. D:/my-new-project", browseDir: false, okLabel: "Create Project" },
    "new-file":    { title: "New File",    placeholder: "e.g. utils.js", browseDir: false, okLabel: "Create File" },
  };
  const dp = dialogMode ? dialogProps[dialogMode] : null;

  return (
    <div className="app">
      <MenuBar menus={menus} />

      <div className="main-area">
        <div className="pane pane-editor">
          <div className="pane-header">
            EDITOR
            {fsBasePath && <span className="pane-header-path">{fsBasePath}</span>}
          </div>
          <EditorPane
            ref={editorRef}
            fsRoot={fsRoot}
            fsBasePath={fsBasePath}
            events={events}
            onOpenFolder={() => showDialog("open-folder")}
            onCreateProject={() => showDialog("new-project")}
            onCreateFile={() => showDialog("new-file")}
            onOpenFile={() => showDialog("open-file")}
            onRefreshFs={refreshFs}
            terminalVisible={termVisible}
            onCloseTerminal={() => setTermVisible(false)}
          />
        </div>

        <ResizeHandle onMouseDown={onConsoleDrag} />

        <div className="pane pane-console" style={{ width: consoleW, minWidth: consoleW }}>
          <TestConsole
            events={events}
            goal={goal}
            onGoalChange={setGoal}
            onRun={handleRun}
            connected={connected}
          />
        </div>
      </div>

      {dp && (
        <PathDialog
          open={!!dialogMode}
          title={dp.title}
          defaultValue={dialogDefault}
          placeholder={dp.placeholder}
          browseDir={dp.browseDir}
          okLabel={dp.okLabel}
          onOk={handleDialogOk}
          onCancel={() => setDialogMode(null)}
        />
      )}
    </div>
  );
}
