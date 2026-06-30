import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import EditorPane, { EditorPaneHandle, type StatusBarState } from "./panes/EditorPane";
import AgentConsole from "./panes/AgentConsole";
import MenuBar from "./panes/MenuBar";
import type { MenuItem } from "./panes/MenuBar";
import StatusBar from "./panes/StatusBar";
import { useWebSocket } from "./hooks/useWebSocket";
import { useResizable, ResizeHandle } from "./hooks/useResizable";
import type { FsEntry } from "./panes/FilesPanel";
import type { DebugConsoleEntry, OutputEntry } from "./panes/TerminalPane";
import { pickAndEnumerateFolder, pickAndReadFile, enumerateHandle } from "./panes/browserFs";
import NameDialog from "./panes/NameDialog";

interface BrowserTab {
  id: string;
  url: string;
  label: string;
}

function reportDebug(hypothesisId: string, location: string, msg: string, data: Record<string, unknown>) {
  // #region debug-point C:app-report
  fetch("http://127.0.0.1:7777/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "desktop-browser-crash",
      runId: "post-fix",
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function normalizeBrowserOpenUrl(rawUrl: string): string {
  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) return "";
  try {
    const parsed = new URL(trimmedUrl);
    if (
      parsed.hostname.endsWith("bing.com") &&
      parsed.pathname.startsWith("/ck/a")
    ) {
      const encodedTarget = parsed.searchParams.get("u");
      if (encodedTarget) {
        const base64Payload = encodedTarget.startsWith("a1") ? encodedTarget.slice(2) : encodedTarget;
        const decodedTarget = atob(base64Payload);
        if (/^https?:\/\//i.test(decodedTarget)) return decodedTarget;
      }
    }
  } catch {
    return trimmedUrl;
  }
  return trimmedUrl;
}

export default function App() {
  const editorRef = useRef<EditorPaneHandle>(null);
  const agentFileActionRef = useRef<((fcPath: string, accepted: boolean) => void) | null>(null);
  const { connected, events, runTest } = useWebSocket();
  const [debugEntries, setDebugEntries] = useState<DebugConsoleEntry[]>([]);
  const [outputEntries, setOutputEntries] = useState<OutputEntry[]>([]);
  const debugIdRef = useRef(0);
  const outputIdRef = useRef(0);
  const wsEventCountRef = useRef(0);

  const [fsRoot, setFsRoot] = useState<FsEntry[] | null>(null);
  const [fsBasePath, setFsBasePath] = useState("");
  const isBrowserFs = useRef(false);
  const [projectVenvDir, setProjectVenvDir] = useState<string>("");
  const [projectActivateScript, setProjectActivateScript] = useState<string>("");
  const [goal, setGoal] = useState("Verify the app works correctly");
  const [termVisible, setTermVisible] = useState(false);
  const termVisibleRef = useRef(false);
  const reopenTerminal = useRef(false);
  const [devtoolsForceKey, setDevtoolsForceKey] = useState(0);
  const [showConsole, setShowConsole] = useState(false);
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    defaultValue?: string;
    onOk: (value: string) => void;
  } | null>(null);

  const [statusBar, setStatusBar] = useState<StatusBarState>({
    cursorLine: 1, cursorColumn: 1,
    language: "plaintext", encoding: "UTF-8", fsBasePath: "", hasFsRoot: false, hasEditor: false,
  });

  const promptName = useCallback((title: string, defaultValue: string | undefined, onOk: (value: string) => void) => {
    setNameDialog({ title, defaultValue, onOk });
  }, []);

  const handleOpenDevtools = useCallback(() => {
    setTermVisible(true);
    setDevtoolsForceKey((n) => n + 1);
  }, []);

  // A single top-level browser editor tab hosts multiple child browser tabs.
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState("");
  const browserIdSeq = useRef(0);

  const openBrowserTabForUrl = useCallback((url: string, forceNew = false) => {
    const normalizedUrl = normalizeBrowserOpenUrl(url);
    if (!normalizedUrl) return;
    if (!forceNew) {
      const existing = browserTabs.find((b) => b.url === normalizedUrl);
      if (existing) {
        setActiveBrowserTabId(existing.id);
        return;
      }
    }
    const id = String(++browserIdSeq.current);
    setBrowserTabs((prev) => [...prev, { id, url: normalizedUrl, label: normalizedUrl.replace(/^https?:\/\//, "") }]);
    setActiveBrowserTabId(id);
  }, [browserTabs]);

  const createBrowserTab = useCallback((url = "", label = "New Tab") => {
    const id = String(++browserIdSeq.current);
    setBrowserTabs((prev) => [...prev, { id, url, label }]);
    setActiveBrowserTabId(id);
  }, []);

  const handleDetectUrl = useCallback((_sessionId: string, url: string) => {
    // #region debug-point C:handle-detect-url
    reportDebug("C", "App.tsx:handleDetectUrl", "terminal detected browser url", {
      sessionId: _sessionId,
      url,
      existingTabs: browserTabs.length,
    });
    // #endregion
    openBrowserTabForUrl(url, true);
  }, [browserTabs.length]);

  const handleAddBrowserTab = useCallback(() => {
    createBrowserTab();
  }, [createBrowserTab]);

  const handleBrowserTabClose = useCallback((id: string) => {
    setBrowserTabs((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      const remaining = prev.filter((b) => b.id !== id);
      setActiveBrowserTabId((current) => {
        if (current !== id) return current;
        const nextIdx = Math.min(idx, Math.max(remaining.length - 1, 0));
        return remaining[nextIdx]?.id || "";
      });
      return remaining;
    });
  }, []);

  const handleBrowserClose = useCallback(() => {
    setBrowserTabs([]);
    setActiveBrowserTabId("");
  }, []);

  const handleBrowserTabUpdateLabel = useCallback((tabId: string, label: string) => {
    setBrowserTabs((prev) => prev.map((b) => b.id === tabId ? { ...b, label } : b));
  }, []);

  const handleBrowserTabUpdateUrl = useCallback((tabId: string, url: string) => {
    setBrowserTabs((prev) => prev.map((b) => b.id === tabId ? { ...b, url } : b));
  }, []);

  const handleBrowserNewTabFromLink = useCallback((url: string) => {
    openBrowserTabForUrl(url);
  }, [openBrowserTabForUrl]);

  const appendDebugEntry = useCallback((entry: Omit<DebugConsoleEntry, "id" | "time"> & { time?: number }) => {
    const next: DebugConsoleEntry = {
      id: `dbg-${++debugIdRef.current}`,
      time: entry.time ?? Date.now(),
      level: entry.level,
      source: entry.source,
      text: entry.text,
    };
    setDebugEntries((prev) => [...prev.slice(-399), next]);
  }, []);

  const clearDebugEntries = useCallback(() => {
    setDebugEntries([]);
  }, []);

  const appendOutputEntry = useCallback((entry: Omit<OutputEntry, "id" | "time"> & { time?: number }) => {
    const next: OutputEntry = {
      id: `out-${++outputIdRef.current}`,
      time: entry.time ?? Date.now(),
      kind: entry.kind,
      text: entry.text,
    };
    setOutputEntries((prev) => [...prev.slice(-399), next]);
  }, []);

  const clearOutputEntries = useCallback(() => {
    setOutputEntries([]);
  }, []);

  useEffect(() => {
    if (events.length <= wsEventCountRef.current) return;
    for (const event of events.slice(wsEventCountRef.current)) {
      const level: DebugConsoleEntry["level"] =
        event.type === "error" ? "error" :
        event.type === "log" ? "log" :
        event.type === "assistant" ? "info" :
        "info";
      let text = "";
      if (typeof event.data === "string") {
        text = event.data;
      } else {
        try {
          text = JSON.stringify(event.data);
        } catch {
          text = String(event.data);
        }
      }
      appendDebugEntry({ level, source: "server", text: `${event.type}: ${text}` });

      const outputText =
        event.type === "action"
          ? `${(event.data as { action: string; index: number; text?: string }).action} [${(event.data as { index: number }).index}]${(event.data as { text?: string }).text ? ` "${(event.data as { text: string }).text}"` : ""}`
          : event.type === "result"
            ? `${(event.data as { verdict: string }).verdict.toUpperCase()}: ${(event.data as { message: string }).message}`
            : event.type === "dom"
              ? String(event.data).slice(0, 2000)
              : event.type === "assistant"
                ? `AI: ${String(event.data).slice(0, 500)}`
                : String(event.data);

      appendOutputEntry({ kind: event.type, text: outputText });
    }
    wsEventCountRef.current = events.length;
  }, [appendDebugEntry, appendOutputEntry, events]);

  useEffect(() => {
    const stringifyArgs = (args: unknown[]) => args.map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(" ");

    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    console.log = (...args: unknown[]) => {
      appendDebugEntry({ level: "log", source: "app", text: stringifyArgs(args) });
      original.log(...args);
    };
    console.info = (...args: unknown[]) => {
      appendDebugEntry({ level: "info", source: "app", text: stringifyArgs(args) });
      original.info(...args);
    };
    console.warn = (...args: unknown[]) => {
      appendDebugEntry({ level: "warn", source: "app", text: stringifyArgs(args) });
      original.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      appendDebugEntry({ level: "error", source: "app", text: stringifyArgs(args) });
      original.error(...args);
    };

    const onError = (event: ErrorEvent) => {
      appendDebugEntry({
        level: "error",
        source: "runtime",
        text: event.error?.stack || event.message || "Unhandled error",
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? (event.reason.stack || event.reason.message) : String(event.reason);
      appendDebugEntry({ level: "error", source: "runtime", text: `Unhandled rejection: ${reason}` });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [appendDebugEntry]);

  useEffect(() => {
    return window.harnessDesktop?.onBrowserOpenUrl?.((url: string) => {
      handleBrowserNewTabFromLink(url);
    });
  }, [handleBrowserNewTabFromLink]);

  useEffect(() => { termVisibleRef.current = termVisible; }, [termVisible]);
  useEffect(() => { if (!termVisible) reopenTerminal.current = false; }, [termVisible]);

  // Resizable console pane (width from right edge)
  const { size: consoleW, onMouseDown: onConsoleDrag } = useResizable(390, 390, 800, true);

  const ensureTerminalVisible = useCallback((restart: boolean) => {
    reopenTerminal.current = true;
    if (restart && termVisibleRef.current) {
      setTermVisible(false);
      setTimeout(() => {
        if (reopenTerminal.current) setTermVisible(true);
      }, 100);
      return;
    }
    setTermVisible(true);
  }, []);

  const detectProject = useCallback(async (basePath: string) => {
    try {
      const res = await fetch(`/api/project/detect?path=${encodeURIComponent(basePath)}`);
      const data = await res.json();
      setProjectVenvDir(typeof data?.venvDir === "string" ? data.venvDir : "");
      setProjectActivateScript(typeof data?.activateScript === "string" ? data.activateScript : "");
    } catch {
      setProjectVenvDir("");
      setProjectActivateScript("");
    }
  }, []);

  const openFolder = useCallback(async (folderPath: string) => {
    const shouldRestartTerminal = termVisibleRef.current;
    if (shouldRestartTerminal) setTermVisible(false);
    try {
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(folderPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFsRoot(data.entries || []);
      setFsBasePath(data.path);
      isBrowserFs.current = false;
      setShowConsole(true);
      await detectProject(data.path);
      ensureTerminalVisible(shouldRestartTerminal);
    } catch (err) { alert(`Failed to open folder: ${err}`); }
  }, [detectProject, ensureTerminalVisible]);

  const openFolderImmediate = useCallback(async () => {
    const desktop = window.harnessDesktop;
    const isElectronUa = navigator.userAgent.includes("Electron");
    if (desktop?.openFolder) {
      const folderPath = await desktop.openFolder();
      if (typeof folderPath === "string" && folderPath.trim()) {
        await openFolder(folderPath.trim());
      }
      return;
    }
    if (isElectronUa) {
      alert("Desktop file picker bridge is not available. Restart Electron after rebuilding, or use an absolute path open.");
    }

    const picked = await pickAndEnumerateFolder();
    if (!picked) return;
    setFsRoot(picked.entries);
    setFsBasePath(picked.name);
    isBrowserFs.current = true;
    setShowConsole(true);
    setProjectVenvDir("");
    setProjectActivateScript("");
    ensureTerminalVisible(false);
  }, [ensureTerminalVisible, openFolder]);

  const refreshFs = useCallback(async () => {
    if (isBrowserFs.current || !fsBasePath) return;
    try {
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(fsBasePath)}`);
      if (!res.ok) { console.error("refreshFs list failed:", res.status); return; }
      const data = await res.json();
      setFsRoot(data.entries || []);
    } catch (err) { console.error("refreshFs error:", err); }
    editorRef.current?.refreshGitStatus?.();
  }, [fsBasePath]);

  // Refresh file tree when window regains focus (e.g. after external file changes).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshFs(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshFs);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshFs);
    };
  }, [refreshFs]);

  const createNewProject = useCallback(async (projectName: string) => {
    try {
      if (fsBasePath) {
        // Create subfolder in current project, then open it
        const sep = fsBasePath.includes("/") ? "/" : "\\";
        const dir = fsBasePath + sep + projectName;
        await fetch("/api/fs/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir }) });
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(dir)}`);
        const data = await res.json();
        if (!data.error) {
          setFsRoot(data.entries || []);
          setFsBasePath(data.path);
          isBrowserFs.current = false;
          detectProject(data.path);
        }
      } else if (window.harnessDesktop?.openFolder) {
        // Desktop mode: pick parent directory, create subfolder, open only the subfolder
        const parentPath = await window.harnessDesktop.openFolder();
        if (!parentPath?.trim()) return;
        const sep = parentPath.includes("/") ? "/" : "\\";
        const dir = parentPath.trim() + sep + projectName;
        await fetch("/api/fs/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir }) });
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(dir)}`);
        const data = await res.json();
        if (!data.error) {
          setFsRoot(data.entries || []);
          setFsBasePath(data.path);
          isBrowserFs.current = false;
          detectProject(data.path);
        }
      } else {
        // Browser mode: pick parent directory, create subfolder, open only the subfolder
        const parentHandle = await (window as any).showDirectoryPicker();
        const projectHandle = await parentHandle.getDirectoryHandle(projectName, { create: true });
        const entries = await enumerateHandle(projectHandle as FileSystemDirectoryHandle);
        const dir = parentHandle.name + (parentHandle.name.includes("/") ? "/" : "\\") + projectName;
        setFsRoot(entries);
        setFsBasePath(dir);
        isBrowserFs.current = true;
        setProjectVenvDir("");
        setProjectActivateScript("");
      }
      setShowConsole(true);
      setTermVisible(true);
    } catch (err) { alert(`Failed to create project: ${err}`); }
  }, [detectProject, fsBasePath, refreshFs]);

  const createNewFile = useCallback(async (name: string) => {
    try {
      const desktop = window.harnessDesktop;
      if (desktop?.openFolder) {
        // Desktop mode: pick folder, create file, open only the new file
        const folderPath = await desktop.openFolder();
        if (!folderPath?.trim()) return;
        const sep = folderPath.includes("/") ? "/" : "\\";
        const filePath = folderPath.trim() + sep + name;
        await fetch("/api/fs/create-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath, content: "" }),
        });
        setFsRoot([{ name, path: filePath, isDirectory: false }]);
        setFsBasePath(folderPath.trim());
        isBrowserFs.current = false;
        detectProject(folderPath.trim());
        editorRef.current?.applyAiFiles([{ name, content: "" }]);
        const files = editorRef.current?.getFiles() || [];
        const created = files.find((f) => f.name === name);
        if (created) created._fsPath = filePath;
      } else if (fsBasePath) {
        // Existing project: create in current folder, refresh full tree
        const sep = fsBasePath.includes("/") ? "/" : "\\";
        const filePath = fsBasePath + sep + name;
        await fetch("/api/fs/create-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath, content: "" }),
        });
        await refreshFs();
        editorRef.current?.applyAiFiles([{ name, content: "" }]);
        const files = editorRef.current?.getFiles() || [];
        const created = files.find((f) => f.name === name);
        if (created) created._fsPath = filePath;
      } else {
        // Web mode no project: pick folder, create file, open only the new file
        const dirHandle = await (window as any).showDirectoryPicker();
        await dirHandle.getFileHandle(name, { create: true });
        const filePath = dirHandle.name + (dirHandle.name.includes("/") ? "/" : "\\") + name;
        setFsRoot([{ name, path: filePath, isDirectory: false }]);
        setFsBasePath(dirHandle.name);
        isBrowserFs.current = true;
        setProjectVenvDir("");
        setProjectActivateScript("");
        editorRef.current?.applyAiFiles([{ name, content: "" }]);
        const files = editorRef.current?.getFiles() || [];
        const created = files.find((f) => f.name === name);
        if (created) created._fsPath = filePath;
      }
      setShowConsole(true);
      setTermVisible(true);
    }
    catch (err) { alert(`Failed to create file: ${err}`); }
  }, [detectProject, fsBasePath, refreshFs]);

  const openFileByPath = useCallback(async (filePath: string) => {
    try {
      const dirPath = filePath.replace(/[/\\][^/\\]+$/, "");
      const shouldRestartTerminal = !!(dirPath && dirPath !== fsBasePath && termVisibleRef.current);
      if (shouldRestartTerminal) setTermVisible(false);
      const res = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      editorRef.current?.applyAiFiles([{ name: filePath.split(/[/\\]/).pop() || "untitled", content: data.content, fsPath: filePath }]);
      setShowConsole(true);
      if (dirPath && dirPath !== fsBasePath) {
        const listRes = await fetch(`/api/fs/list?path=${encodeURIComponent(dirPath)}`);
        const listData = await listRes.json();
        if (!listData?.error) {
          setFsRoot(listData.entries || []);
          setFsBasePath(listData.path || dirPath);
          isBrowserFs.current = false;
          await detectProject(listData.path || dirPath);
        }
      }
      ensureTerminalVisible(shouldRestartTerminal);
    } catch (err) { alert(`Failed to open file: ${err}`); }
  }, [detectProject, ensureTerminalVisible, fsBasePath]);

  const openFileImmediate = useCallback(async () => {
    const desktop = window.harnessDesktop;
    const isElectronUa = navigator.userAgent.includes("Electron");
    if (desktop?.openFile) {
      const filePath = await desktop.openFile();
      if (typeof filePath === "string" && filePath.trim()) {
        await openFileByPath(filePath.trim());
      }
      return;
    }
    if (isElectronUa) {
      alert("Desktop file picker bridge is not available. Restart Electron after rebuilding, or use an absolute path open.");
    }

    const picked = await pickAndReadFile();
    if (!picked) return;
    editorRef.current?.applyAiFiles([{ name: picked.name, content: picked.content }]);
    setShowConsole(true);
    const files = editorRef.current?.getFiles() || [];
    const last = files[files.length - 1];
    if (last) last._fsHandle = picked.handle;
    ensureTerminalVisible(false);
  }, [ensureTerminalVisible, openFileByPath]);

  const handleRun = useCallback(() => {
    const code = editorRef.current?.getCode();
    if (!code) return;
    runTest({ html: code.html, css: code.css, js: code.js, goal, maxSteps: 10 });
  }, [runTest, goal]);

  const menus = useMemo(() => [
    {
      label: "File",
      items: ([] as (MenuItem | "---")[]).concat(
        { label: "Open Folder...", shortcut: "Ctrl+K Ctrl+O", action: () => { void openFolderImmediate(); } },
        { label: "Open File...", shortcut: "Ctrl+O", action: () => { void openFileImmediate(); } },
        "---" as const,
        { label: "New Project...", action: () => {
          promptName("Project name:", undefined, (name) => { void createNewProject(name); });
        } },
        { label: "New File", shortcut: "Ctrl+N", action: () => {
          promptName("File name:", undefined, (name) => { void createNewFile(name); });
        } },
        "---" as const,
        { label: "Save", shortcut: "Ctrl+S", action: () => {
          const files = editorRef.current?.getFiles(); if (files) for (const f of files) { if (f._fsPath) fetch("/api/fs/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: f._fsPath, content: f.content }) }).catch(() => {}); }
        }},
        // Conditionals
        ...(fsBasePath
          ? [{ label: "Close Folder", shortcut: "Ctrl+K F", action: () => { setFsRoot(null); setFsBasePath(""); isBrowserFs.current = false; setProjectVenvDir(""); setProjectActivateScript(""); handleBrowserClose(); setTermVisible(false); setShowConsole(false); } } as MenuItem]
          : []),
        ...(statusBar.hasEditor
          ? [{ label: "Close File", shortcut: "Ctrl+W", action: () => { editorRef.current?.closeActiveTab(); } } as MenuItem]
          : []),
      ),
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
  ], [fsBasePath, statusBar.hasEditor, openFolderImmediate, openFileImmediate, createNewProject, createNewFile, handleBrowserClose]);

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
            terminalVenvDir={projectVenvDir}
            terminalActivateScript={projectActivateScript}
            browserTabs={browserTabs}
            activeBrowserTabId={activeBrowserTabId}
            onActiveBrowserTabChange={setActiveBrowserTabId}
            onCloseBrowser={handleBrowserClose}
            onBrowserTabClose={handleBrowserTabClose}
            onAddBrowserTab={handleAddBrowserTab}
            onBrowserTabUpdateLabel={handleBrowserTabUpdateLabel}
            onBrowserTabUpdateUrl={handleBrowserTabUpdateUrl}
            onBrowserNewTabFromLink={handleBrowserNewTabFromLink}
            onOpenFolder={() => { void openFolderImmediate(); }}
            onCreateProject={() => {
              promptName("Project name:", undefined, (name) => { void createNewProject(name); });
            }}
            onCreateFile={() => {
              promptName("File name:", "index.js", (name) => { void createNewFile(name); });
            }}
            onOpenFile={() => { void openFileImmediate(); }}
            onRefreshFs={refreshFs}
            terminalVisible={termVisible}
            onCloseTerminal={() => setTermVisible(false)}
            onDetectUrl={handleDetectUrl}
            debugEntries={debugEntries}
            onClearDebugEntries={clearDebugEntries}
            outputEntries={outputEntries}
            onClearOutputEntries={clearOutputEntries}
            onOpenDevtools={handleOpenDevtools}
            devtoolsForceKey={devtoolsForceKey}
            onStatusChange={setStatusBar}
            onBannerAcceptFile={(fp) => agentFileActionRef.current?.(fp, true)}
            onBannerRejectFile={(fp) => agentFileActionRef.current?.(fp, false)}
          />
        </div>

        {showConsole && <ResizeHandle onMouseDown={onConsoleDrag} />}

        {showConsole && (
        <div className="pane pane-console" style={{ width: consoleW, minWidth: consoleW }}>
          <AgentConsole
            events={events}
            goal={goal}
            onGoalChange={setGoal}
            onRun={handleRun}
            connected={connected}
            getConsoleContext={() => editorRef.current?.getConsoleContext() || ""}
            executeBrowserAction={(name, params) => editorRef.current?.executeBrowserAction(name, params) ?? Promise.resolve("Browser not available")}
            getProjectFiles={() => editorRef.current?.getProjectFiles() ?? Promise.resolve([])}
            getFsBasePath={() => editorRef.current?.getFsBasePath() || ""}
            refreshEditor={(files) => editorRef.current?.applyAiFiles(files)}
            applyAgentFileChanges={(changes) => editorRef.current?.applyAgentFileChanges(changes)}
            onRefreshFs={refreshFs}
            setAgentFileActionRef={(fn) => { agentFileActionRef.current = fn; }}
            openEditorFile={(path) => { editorRef.current?.openFileByFsPath(path); }}
            acceptEditorChange={(path) => { editorRef.current?.acceptAgentChange(path); }}
            rejectEditorChange={(path) => { editorRef.current?.rejectAgentChange(path); }}
          />
        </div>
        )}
      </div>
      <StatusBar
        cursorLine={statusBar.cursorLine}
        cursorColumn={statusBar.cursorColumn}
        language={statusBar.language}
        encoding={statusBar.encoding}
        fsBasePath={statusBar.fsBasePath}
        hasFsRoot={statusBar.hasFsRoot}
        hasEditor={statusBar.hasEditor}
        onSelectLanguage={(lang) => editorRef.current?.setLanguage(lang)}
        onGoToLine={(line) => editorRef.current?.goToLine(line)}
        onGoToBracket={() => editorRef.current?.goToBracket()}
        onIndentChange={(opts) => editorRef.current?.setIndent(opts)}
        onLineEndingChange={(le) => editorRef.current?.setLineEnding(le)}
        onEncodingChange={(enc) => { editorRef.current?.setEncoding(enc); }}
      />
      <NameDialog
        open={!!nameDialog}
        title={nameDialog?.title || ""}
        defaultValue={nameDialog?.defaultValue}
        onOk={(value) => {
          nameDialog?.onOk(value);
          setNameDialog(null);
        }}
        onCancel={() => setNameDialog(null)}
      />
    </div>
  );
}
