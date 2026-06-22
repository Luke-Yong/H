import { useState, forwardRef, useImperativeHandle, useCallback, useEffect, useRef, useMemo } from "react";
import Editor from "@monaco-editor/react";
import FilesPanel from "./FilesPanel";
import BrowserView from "./BrowserView";
import TerminalPane, { type DebugConsoleEntry, type OutputEntry, type ProblemEntry, type BrowserConsoleEntry } from "./TerminalPane";
import { VFile, createFile, detectLanguage } from "./fileModel";
import { readFileFromHandle, writeFileToHandle } from "./browserFs";
import { useResizable, ResizeHandle } from "../hooks/useResizable";
import NameDialog from "./NameDialog";
import ScmPanel from "./ScmPanel";
import type { FsEntry } from "./FilesPanel";

interface BrowserTab {
  id: string;
  url: string;
  label: string; // short display name for the tab
}

const BROWSER_EDITOR_TAB_ID = "browser";

export interface EditorPaneHandle {
  getCode: () => { html: string; css: string; js: string };
  getFiles: () => VFile[];
  applyAiFiles: (files: { name: string; content: string }[]) => void;
  goToLine: (line: number) => void;
  goToBracket: () => void;
  setLanguage: (lang: string) => void;
  setIndent: (opts: { tabSize: number; insertSpaces: boolean }) => void;
  setLineEnding: (le: string) => void;
  setEncoding: (enc: string) => Promise<void>;
}

export interface StatusBarState {
  cursorLine: number;
  cursorColumn: number;
  language: string;
  encoding: string;
  fsBasePath: string;
  hasFsRoot: boolean;
  hasEditor: boolean;
}

interface Props {
  fsRoot: FsEntry[] | null;
  fsBasePath: string;
  terminalVenvDir: string;
  terminalActivateScript: string;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string;
  onActiveBrowserTabChange: (id: string) => void;
  onCloseBrowser: () => void;
  onBrowserTabClose: (id: string) => void;
  onAddBrowserTab: () => void;
  onBrowserTabUpdateLabel?: (tabId: string, label: string) => void;
  onBrowserTabUpdateUrl?: (tabId: string, url: string) => void;
  onBrowserNewTabFromLink?: (url: string) => void;
  onOpenFolder: () => void;
  onCreateProject: () => void;
  onCreateFile: () => void;
  onOpenFile: () => void;
  onRefreshFs: () => void;
  terminalVisible: boolean;
  onCloseTerminal: () => void;
  onDetectUrl?: (sessionId: string, url: string) => void;
  debugEntries?: DebugConsoleEntry[];
  onClearDebugEntries?: () => void;
  outputEntries?: OutputEntry[];
  onClearOutputEntries?: () => void;
  onOpenDevtools?: () => void;
  devtoolsForceKey?: number;
  onStatusChange?: (state: StatusBarState) => void;
}

interface MarkerSnapshot {
  message: string;
  severity: number;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  code?: string | { value: string };
}

interface EditorViewHandle {
  focus: () => void;
  setPosition: (position: { lineNumber: number; column: number }) => void;
  revealPositionInCenter: (position: { lineNumber: number; column: number }) => void;
  onDidChangeCursorPosition: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => { dispose: () => void };
}

const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { fsRoot, fsBasePath, terminalVenvDir, terminalActivateScript, browserTabs, activeBrowserTabId,
    onActiveBrowserTabChange, onCloseBrowser, onBrowserTabClose, onAddBrowserTab,
    onBrowserTabUpdateLabel, onBrowserTabUpdateUrl, onBrowserNewTabFromLink,
    onOpenFolder, onCreateProject, onCreateFile, onOpenFile, onRefreshFs,
    terminalVisible, onCloseTerminal, onDetectUrl, debugEntries, onClearDebugEntries, outputEntries, onClearOutputEntries,
    onOpenDevtools, devtoolsForceKey, onStatusChange }, ref
) {
  const [files, setFiles] = useState<VFile[]>([]);
  const [markersByFileId, setMarkersByFileId] = useState<Record<string, MarkerSnapshot[]>>({});
  const [activeFileId, setActiveFileId] = useState<string>("");
  const activeFileIdRef = useRef(activeFileId);
  const editorByFileIdRef = useRef<Record<string, EditorViewHandle | null>>({});
  const pendingProblemSelectionRef = useRef<{ fileId: string; line: number; column: number } | null>(null);
  const { size: filePanelW, onMouseDown: onFilePanelDrag } = useResizable(200, 120, 500);
  const { size: termH, onMouseDown: onTermDrag } = useResizable(220, 80, 600, true);
  const [sidebarPanel, setSidebarPanel] = useState<string>("");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [browserConsoleMap, setBrowserConsoleMap] = useState<Record<string, BrowserConsoleEntry[]>>({});
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    defaultValue?: string;
    onOk: (value: string) => void;
  } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [gitChanges, setGitChanges] = useState<Map<string, string>>(new Map()); // absolutePath → status letter
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set()); // file ids that have unsaved changes
  const [gitDiffs, setGitDiffs] = useState<Record<string, string>>({}); // fileId → unified diff text
  const diffDecorationsRef = useRef<Record<string, string[]>>({}); // fileId → decorationIds

  function applyDecorations(editor: any, fileId: string, diffText: string | undefined, markers: MarkerSnapshot[] | undefined) {
    try {
      const monaco = (window as any).monaco;
      if (!monaco) return;
      const model = editor.getModel();
      if (!model) return;
      const lineCount = model.getLineCount();

      // Clear old decorations for this file
      const old = diffDecorationsRef.current[fileId];
      if (old?.length) editor.deltaDecorations(old, []);
      const newDecorations: any[] = [];

      // ── Git diff decorations (left gutter + overview ruler) ──
      if (diffText) {
        const lines = diffText.split("\n");
        let oldLine = 0, newLine = 0;
        for (const line of lines) {
          if (line.startsWith("@@")) {
            const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (m) { oldLine = parseInt(m[1], 10); newLine = parseInt(m[3], 10); }
          } else if (line.startsWith("+") && !line.startsWith("+++")) {
            if (newLine <= lineCount) {
              newDecorations.push({
                range: new monaco.Range(newLine, 1, newLine, 1),
                options: {
                  isWholeLine: true,
                  linesDecorationsClassName: "git-added-line",
                  glyphMarginClassName: "git-added-glyph",
                  overviewRuler: { color: "#2ea043", position: monaco.editor.OverviewRulerLane.Right },
                },
              });
            }
            newLine++;
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            oldLine++;
          } else if (!line.startsWith("\\")) {
            oldLine++; newLine++;
          }
        }
      }

      // ── Error/warning decorations (overview ruler + left gutter) ──
      if (markers && markers.length > 0) {
        const seen = new Set<number>();
        for (const m of markers) {
          if (seen.has(m.startLineNumber)) continue;
          seen.add(m.startLineNumber);
          const severity = (m as any).severity; // 1=Hint, 2=Info, 4=Warning, 8=Error
          const isError = severity === 8;
          const isWarning = severity === 4;
          if ((isError || isWarning) && m.startLineNumber <= lineCount) {
            newDecorations.push({
              range: new monaco.Range(m.startLineNumber, 1, m.startLineNumber, 1),
              options: {
                isWholeLine: true,
                overviewRuler: {
                  color: isError ? "#f85149" : "#d29922",
                  position: monaco.editor.OverviewRulerLane.Full,
                },
                glyphMarginClassName: isError ? "error-glyph" : "warning-glyph",
              },
            });
          }
        }
      }

      const ids = editor.deltaDecorations([], newDecorations);
      diffDecorationsRef.current[fileId] = ids;
    } catch { /* */ }
  }

  // Fetch git status for FilesPanel markers and diff annotations
  useEffect(() => {
    if (!fsBasePath) { setGitChanges(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/git/status?path=${encodeURIComponent(fsBasePath)}`);
        const data = await res.json();
        if (cancelled || !data.ok) return;
        const gitRoot: string = data.gitRoot || fsBasePath;
        const m = new Map<string, string>();
        for (const c of ([] as Array<{ path: string; status: string }>).concat(data.staged || [], data.unstaged || [])) {
          const absPath = gitRoot.replace(/\\/g, "/").replace(/\/$/, "") + "/" + c.path.replace(/\\/g, "/");
          // Keep highest priority status: M > A > D > U
          const existing = m.get(absPath);
          const prio: Record<string, number> = { "M": 4, "A": 3, "D": 2, "U": 1, "?": 0 };
          const s = c.status[0];
          if (!existing || (prio[s] || 0) > (prio[existing] || 0)) {
            m.set(absPath, s);
          }
        }
        setGitChanges(m);
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [fsBasePath]);

  // Fetch git diff for active file and apply decorations
  useEffect(() => {
    const f = files.find((x) => x.id === activeFileId);
    if (!f?._fsPath) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/git/diff?path=${encodeURIComponent(fsBasePath)}&file=${encodeURIComponent(f._fsPath!)}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.ok && data.diff) {
          setGitDiffs((prev) => ({ ...prev, [f.id]: data.diff }));
        } else {
          setGitDiffs((prev) => { const n = { ...prev }; delete n[f.id]; return n; });
        }
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [activeFileId, files, fsBasePath]);

  // Apply decorations when diff or markers change for active file
  useEffect(() => {
    const editor = editorByFileIdRef.current[activeFileId];
    const diffText = gitDiffs[activeFileId];
    const markers = markersByFileId[activeFileId];
    if (editor) applyDecorations(editor, activeFileId, diffText, markers);
  }, [activeFileId, gitDiffs, markersByFileId]);

  const handleBrowserConsoleEntry = useCallback((entryTabId: string, entry: BrowserConsoleEntry) => {
    setBrowserConsoleMap((prev) => {
      const entries = prev[entryTabId] || [];
      return { ...prev, [entryTabId]: [...entries.slice(-499), entry] };
    });
  }, []);

  const handleClearBrowserConsole = useCallback(() => {
    const activeId = activeBrowserTabId;
    if (!activeId) return;
    setBrowserConsoleMap((prev) => ({ ...prev, [activeId]: [] }));
  }, [activeBrowserTabId]);

  const sidebarItems = [
    { id: "files", icon: "📁", label: "Explorer", title: "Explorer (Ctrl+Shift+E)" },
    { id: "search", icon: "🔍", label: "Search", title: "Search (Ctrl+Shift+F)" },
    { id: "scm", icon: "⎇", label: "Source Control", title: "Source Control (Ctrl+Shift+G)" },
    { id: "browser", icon: "🌐", label: "Preview", title: "Browser Preview" },
    { id: "debug", icon: "🐛", label: "Debug", title: "Run and Debug (Ctrl+Shift+D)" },
    { id: "remote", icon: "⊞", label: "Remote Explorer", title: "Remote Explorer" },
    { id: "extensions", icon: "🧩", label: "Extensions", title: "Extensions (Ctrl+Shift+X)" },
  ];

  const hasBrowserTabs = browserTabs.length > 0;
  const hasContent = files.length > 0 || (fsRoot && fsRoot.length > 0) || hasBrowserTabs;
  const showWelcomeInEditor =
    terminalVisible &&
    !hasContent &&
    !fsBasePath &&
    (!fsRoot || fsRoot.length === 0);
  const activeBrowserTab = browserTabs.find((b) => b.id === activeBrowserTabId) || browserTabs[0];
  const activeFile = files.find((f) => f.id === activeFileId);
  const activeLanguage = activeFile?.language || "plaintext";
  const activeEncoding = activeFile?._encoding || "UTF-8";

  const handleSetLanguage = useCallback((lang: string) => {
    if (!activeFileId) return;
    setFiles((prev) => prev.map((f) =>
      f.id === activeFileId ? { ...f, language: lang } : f
    ));
  }, [activeFileId]);
  const hasFsRoot = !!(fsRoot && fsRoot.length > 0) || !!fsBasePath;
  const hasEditor = activeFileId !== "";

  // Notify parent of status bar state
  useEffect(() => {
    onStatusChange?.({
      cursorLine: cursorPos.line,
      cursorColumn: cursorPos.column,
      language: activeLanguage,
      encoding: activeEncoding,
      fsBasePath,
      hasFsRoot,
      hasEditor,
    });
  }, [cursorPos.line, cursorPos.column, activeLanguage, activeEncoding, fsBasePath, hasFsRoot, hasEditor, onStatusChange]);

  const handleGoToLine = useCallback((line: number) => {
    const editor = editorByFileIdRef.current[activeFileId];
    if (!editor) return;
    const model = (editor as any).getModel?.();
    const maxLine = model?.getLineCount?.() || 99999;
    if (line >= 1 && line <= maxLine) {
      editor.revealPositionInCenter({ lineNumber: line, column: 1 });
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    }
  }, [activeFileId]);

  const handleIndentChange = useCallback((opts: { tabSize: number; insertSpaces: boolean }) => {
    const editor = editorByFileIdRef.current[activeFileId];
    if (editor) {
      (editor as any).updateOptions?.({ tabSize: opts.tabSize, insertSpaces: opts.insertSpaces });
    }
  }, [activeFileId]);

  const handleGoToBracket = useCallback(() => {
    const editor = editorByFileIdRef.current[activeFileId];
    if (editor) {
      (editor as any).getAction("editor.action.jumpToBracket")?.run();
      editor.focus();
    }
  }, [activeFileId]);

  const handleLineEnding = useCallback((le: string) => {
    const editor = editorByFileIdRef.current[activeFileId];
    if (editor && le) {
      // Monaco EndOfLineSequence: 1=LF, 2=CRLF
      const eol = le === "CRLF" ? 2 : 1;
      (editor as any).getModel()?.setEOL(eol);
    }
  }, [activeFileId]);

  const problemEntries = useMemo<ProblemEntry[]>(() => {
    const severityMap: Record<number, ProblemEntry["severity"]> = {
      8: "error",
      4: "warning",
      2: "info",
      1: "hint",
    };
    return files.flatMap((file) => {
      const markers = markersByFileId[file.id] || [];
      return markers.map((marker, index) => ({
        id: `${file.id}-${index}-${marker.startLineNumber}-${marker.startColumn}-${marker.message}`,
        fileId: file.id,
        fileName: file.name,
        filePath: file._fsPath,
        severity: severityMap[marker.severity] || "info",
        message: marker.message,
        line: marker.startLineNumber,
        column: marker.startColumn,
        endLine: marker.endLineNumber,
        endColumn: marker.endColumn,
        source: marker.source,
        code: typeof marker.code === "string" ? marker.code : marker.code?.value,
      }));
    });
  }, [files, markersByFileId]);

  useEffect(() => { activeFileIdRef.current = activeFileId; }, [activeFileId]);

  useEffect(() => {
    const pending = pendingProblemSelectionRef.current;
    if (!pending || pending.fileId !== activeFileId) return;
    const editor = editorByFileIdRef.current[pending.fileId];
    if (!editor) return;
    const position = { lineNumber: pending.line, column: pending.column };
    requestAnimationFrame(() => {
      editor.revealPositionInCenter(position);
      editor.setPosition(position);
      editor.focus();
      pendingProblemSelectionRef.current = null;
    });
  }, [activeFileId]);

  // Keep browser pages under one top-level editor tab and focus it when a child tab is added.
  const prevBrowserCount = useRef(0);
  useEffect(() => {
    if (browserTabs.length > prevBrowserCount.current && browserTabs.length > 0) {
      setActiveFileId(BROWSER_EDITOR_TAB_ID);
    }
    if (browserTabs.length === 0 && activeFileIdRef.current === BROWSER_EDITOR_TAB_ID) {
      setActiveFileId(files[0]?.id || "");
    }
    prevBrowserCount.current = browserTabs.length;
  }, [browserTabs, files]);

  // Auto-open files panel when a folder is loaded
  const hadFolderRef = useRef(false);
  useEffect(() => {
    const hasFolder = !!(fsRoot && fsRoot.length > 0) || !!fsBasePath;
    if (!hasFolder) {
      hadFolderRef.current = false;
      return;
    }
    if (!hadFolderRef.current) {
      setSidebarPanel("files");
      setSidebarVisible(true);
      hadFolderRef.current = true;
    }
  }, [fsRoot, fsBasePath]);

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
        f._encoding = data.encoding || "utf8";
        setFiles((prev) => [...prev, f]);
        setActiveFileId(f.id);
      }
    } catch (err) { console.error("Failed to open file:", err); }
  }, [files]);

  const setEncoding = useCallback(async (enc: string) => {
    const f = files.find((x) => x.id === activeFileId);
    if (!f || !f._fsPath) return;
    try {
      const res = await fetch(`/api/fs/read-encoding?path=${encodeURIComponent(f._fsPath)}&encoding=${encodeURIComponent(enc)}`);
      const data = await res.json();
      setFiles((prev) => prev.map((x) =>
        x.id === activeFileId ? { ...x, content: data.content, _encoding: enc } : x
      ));
    } catch { /* */ }
  }, [files, activeFileId]);

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

  useImperativeHandle(ref, () => ({
    getCode, getFiles: () => files, applyAiFiles,
    goToLine: handleGoToLine, goToBracket: handleGoToBracket,
    setLanguage: handleSetLanguage, setIndent: handleIndentChange,
    setLineEnding: handleLineEnding, setEncoding,
  }), [getCode, files, applyAiFiles, handleGoToLine, handleGoToBracket, handleSetLanguage, handleIndentChange, handleLineEnding, setEncoding]);

  const updateFile = useCallback((id: string, content: string) => {
    setDirtyFiles((prev) => { const next = new Set(prev); next.add(id); return next; });
    setFiles((prev) => prev.map((f) =>
      f.id !== id ? f : { ...f, content }
    ));
  }, []);

  const saveFile = useCallback((id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    if (f._fsHandle) {
      writeFileToHandle(f._fsHandle, f.content).catch(() => {});
    } else if (f._fsPath) {
      fetch("/api/fs/write", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: f._fsPath, content: f.content }),
      }).catch(() => {});
    }
    setDirtyFiles((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, [files]);

  // Ctrl+S save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeFileId) saveFile(activeFileId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFileId, saveFile]);

  const updateProblemMarkers = useCallback((fileId: string, markers: readonly MarkerSnapshot[]) => {
    setMarkersByFileId((prev) => ({
      ...prev,
      [fileId]: [...markers],
    }));
  }, []);

  const handleSelectProblem = useCallback((problem: ProblemEntry) => {
    pendingProblemSelectionRef.current = {
      fileId: problem.fileId,
      line: problem.line,
      column: problem.column,
    };
    setActiveFileId(problem.fileId);

    const editor = editorByFileIdRef.current[problem.fileId];
    if (editor && activeFileIdRef.current === problem.fileId) {
      const position = { lineNumber: problem.line, column: problem.column };
      requestAnimationFrame(() => {
        editor.revealPositionInCenter(position);
        editor.setPosition(position);
        editor.focus();
        pendingProblemSelectionRef.current = null;
      });
    }
  }, []);

  const addFile = useCallback(() => {
    setNameDialog({ title: "New File", defaultValue: "untitled.js", onOk: async (name) => {
      if (fsBasePath) {
        // Create file on disk, refresh tree, open in editor
        const sep = fsBasePath.includes("/") ? "/" : "\\";
        const filePath = fsBasePath + sep + name;
        try {
          await fetch("/api/fs/create-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: filePath, content: "" }),
          });
          onRefreshFs();
        } catch { /* ignore - still create virtual tab */ }
        setFiles((prev) => {
          const f = createFile(name);
          f._fsPath = filePath;
          setActiveFileId(f.id);
          return [...prev, f];
        });
      } else {
        setFiles((prev) => {
          const f = createFile(name);
          setActiveFileId(f.id);
          return [...prev, f];
        });
      }
      setNameDialog(null);
    }});
  }, [fsBasePath, onRefreshFs]);

  const closeTab = useCallback((id: string) => {
    if (id === BROWSER_EDITOR_TAB_ID) {
      onCloseBrowser();
      if (activeFileIdRef.current === id) setActiveFileId(files[0]?.id || "");
      return;
    }
    setMarkersByFileId((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    delete editorByFileIdRef.current[id];
    if (pendingProblemSelectionRef.current?.fileId === id) {
      pendingProblemSelectionRef.current = null;
    }
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      const remaining = prev.filter((f) => f.id !== id);
      if (activeFileIdRef.current === id) {
        const next = remaining[Math.min(Math.max(idx, 0), Math.max(0, remaining.length - 1))];
        setActiveFileId(next?.id || "");
      } else if (
        activeFileIdRef.current &&
        activeFileIdRef.current !== BROWSER_EDITOR_TAB_ID &&
        !remaining.some((f) => f.id === activeFileIdRef.current)
      ) {
        setActiveFileId(remaining[0]?.id || "");
      }
      return remaining;
    });
  }, [files, onCloseBrowser]);

  const renameFile = useCallback((id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    setNameDialog({ title: "Rename", defaultValue: f.name, onOk: (newName) => {
      if (newName !== f.name) {
        setFiles((prev) => prev.map((x) =>
          x.id === id ? { ...x, name: newName, language: detectLanguage(newName) } : x
        ));
      }
      setNameDialog(null);
    }});
  }, [files]);

  if (!hasContent && !terminalVisible) {
    return (
      <>
      <div className="ide-layout">
        <div className="activity-bar">
          {sidebarItems.map((item) => (
            <button
              key={item.id}
              className={`activity-bar-btn${(item.id === "browser" && hasBrowserTabs) || (item.id !== "browser" && sidebarPanel === item.id && sidebarVisible) ? " active" : ""}`}
              onClick={() => {
                if (item.id === "browser") {
                  if (hasBrowserTabs) { setActiveFileId(BROWSER_EDITOR_TAB_ID); } else { onAddBrowserTab(); }
                  return;
                }
                if (item.id === sidebarPanel) { setSidebarVisible((v) => !v); return; }
                setSidebarPanel(item.id); setSidebarVisible(true);
              }}
              title={item.title}
            >
              {item.icon}
            </button>
          ))}
          <div className="activity-bar-spacer" />
          <button className="activity-bar-btn" title="Manage">⚙</button>
        </div>
        {sidebarVisible && sidebarPanel && sidebarPanel !== "browser" && sidebarPanel !== "files" && sidebarPanel !== "scm" && (
          <div className="sidebar-placeholder">
            <div className="sidebar-placeholder-text">{sidebarItems.find((i) => i.id === sidebarPanel)?.label || ""}</div>
            {sidebarPanel === "search" && <div className="placeholder-sub">Search across files coming soon</div>}
            {sidebarPanel === "debug" && <div className="placeholder-sub">Debug console coming soon</div>}
            {sidebarPanel === "remote" && <div className="placeholder-sub">Remote connections coming soon</div>}
            {sidebarPanel === "extensions" && <div className="placeholder-sub">Extension marketplace coming soon</div>}
          </div>
        )}
        {sidebarVisible && sidebarPanel === "scm" && <ScmPanel fsBasePath={fsBasePath} />}
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
              <span className="welcome-btn-text"><strong>New Project</strong><small>Create an empty folder for your project</small></span>
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
      <NameDialog
        open={!!nameDialog}
        title={nameDialog?.title || ""}
        defaultValue={nameDialog?.defaultValue}
        onOk={(value) => { nameDialog?.onOk(value); }}
        onCancel={() => setNameDialog(null)}
      />
      </>
    );
  }

  return (
    <>
    <div className="ide-layout">
      <div className="activity-bar">
        {sidebarItems.map((item) => (
          <button
            key={item.id}
            className={`activity-bar-btn${(item.id === "browser" && hasBrowserTabs) || (item.id !== "browser" && sidebarPanel === item.id && sidebarVisible) ? " active" : ""}`}
            onClick={() => {
              if (item.id === "browser") {
                if (hasBrowserTabs) { setActiveFileId(BROWSER_EDITOR_TAB_ID); } else { onAddBrowserTab(); }
                return;
              }
              if (item.id === sidebarPanel) { setSidebarVisible((v) => !v); return; }
              setSidebarPanel(item.id);
              setSidebarVisible(true);
            }}
            title={item.title}
          >
            {item.icon}
          </button>
        ))}
        <div className="activity-bar-spacer" />
        <button className="activity-bar-btn" title="Manage">⚙</button>
      </div>
      {sidebarVisible && sidebarPanel === "files" && (
        <>
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
            gitChanges={gitChanges}
          />
          <ResizeHandle onMouseDown={onFilePanelDrag} />
        </>
      )}
      {sidebarVisible && sidebarPanel && sidebarPanel !== "files" && sidebarPanel !== "browser" && sidebarPanel !== "scm" && (
        <div className="sidebar-placeholder">
          <div className="sidebar-placeholder-text">{sidebarItems.find((i) => i.id === sidebarPanel)?.label || ""}</div>
          {sidebarPanel === "search" && (
            <div className="placeholder-sub">Search across files coming soon</div>
          )}
          {sidebarPanel === "debug" && (
            <div className="placeholder-sub">Debug console coming soon</div>
          )}
          {sidebarPanel === "remote" && (
            <div className="placeholder-sub">Remote connections coming soon</div>
          )}
          {sidebarPanel === "extensions" && (
            <div className="placeholder-sub">Extension marketplace coming soon</div>
          )}
        </div>
      )}
      {sidebarVisible && sidebarPanel === "scm" && <ScmPanel fsBasePath={fsBasePath} />}
      <div className="ide-editor-area">
        <div className="editor-tabs">
          {files.length === 0 && !hasBrowserTabs && (
            <div className="editor-tab tab-hint">Open a file from the sidebar to begin</div>
          )}
          {files.map((f) => {
            const fileMarkers = markersByFileId[f.id] || [];
            const errCount = fileMarkers.filter((m: any) => m.severity === 8).length;
            const warnCount = fileMarkers.filter((m: any) => m.severity === 4).length;
            const hasError = errCount > 0;
            const hasWarning = warnCount > 0;
            return (
            <button key={f.id} className={`editor-tab${f.id === activeFileId ? " active" : ""}`} onClick={() => setActiveFileId(f.id)}>
              {dirtyFiles.has(f.id) && <span className="tab-dirty-dot" title="Unsaved"> ● </span>}
              <span className={`tab-name${hasError ? " tab-name-err" : ""}${!hasError && hasWarning ? " tab-name-warn" : ""}`}>{f.name}</span>
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(f.id); }}>✕</span>
            </button>
            );
          })}
          {hasBrowserTabs && (
            <button
              className={`editor-tab${activeFileId === BROWSER_EDITOR_TAB_ID ? " active" : ""}`}
              onClick={() => setActiveFileId(BROWSER_EDITOR_TAB_ID)}
            >
              🌐 browser
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(BROWSER_EDITOR_TAB_ID); }}>✕</span>
            </button>
          )}
          {!hasBrowserTabs && (
            <button className="editor-tab editor-tab-add" onClick={onAddBrowserTab} title="Open browser">+ 🌐</button>
          )}
        </div>
        <div className="editor-main" style={{ flex: 1, overflow: "hidden" }}>
          <div className="editor-container">
            {showWelcomeInEditor && (
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
                    <span className="welcome-btn-text"><strong>New Project</strong><small>Create an empty folder for your project</small></span>
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
            )}
            {!showWelcomeInEditor && files.length === 0 && !hasBrowserTabs && (
              <div className="editor-empty">
                <p>Select a file</p>
              </div>
            )}
            {hasBrowserTabs && activeFileId === BROWSER_EDITOR_TAB_ID && (
              <div style={{ height: "100%" }}>
                <BrowserView
                  tabs={browserTabs}
                  activeTabId={activeBrowserTab?.id || ""}
                  onSelectTab={onActiveBrowserTabChange}
                  onCloseTab={onBrowserTabClose}
                  onAddTab={onAddBrowserTab}
                  onTitleChange={onBrowserTabUpdateLabel}
                  onUrlChange={onBrowserTabUpdateUrl}
                  onNewTab={onBrowserNewTabFromLink}
                  onConsoleEntry={handleBrowserConsoleEntry}
                  onOpenDevtools={onOpenDevtools}
                />
              </div>
            )}
            {files.map((f) => (
              <div key={f.id} style={{ display: f.id === activeFileId ? "flex" : "none", height: "100%" }}>
                <Editor
                  height="100%" language={f.language} theme="vs-dark"
                  value={f.content} onChange={(val) => updateFile(f.id, val || "")}
                  onMount={(editor) => {
                    const ed = editor as EditorViewHandle;
                    editorByFileIdRef.current[f.id] = ed;
                    ed.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
                      if (activeFileIdRef.current === f.id) {
                        setCursorPos({ line: e.position.lineNumber, column: e.position.column });
                      }
                    });
                  }}
                  onValidate={(markers) => updateProblemMarkers(f.id, markers)}
                  options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, lineNumbers: "on", renderWhitespace: "selection", glyphMargin: true, overviewRulerLanes: 3 }}
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
                debugEntries={debugEntries}
                onClearDebugEntries={onClearDebugEntries}
                outputEntries={outputEntries}
                onClearOutputEntries={onClearOutputEntries}
                problemEntries={problemEntries}
                onSelectProblem={handleSelectProblem}
                browserConsoleEntries={browserConsoleMap[activeBrowserTab?.id || ""] || []}
                onClearBrowserConsole={handleClearBrowserConsole}
                devtoolsForceKey={devtoolsForceKey}
              />
            </div>
          </>
        )}
      </div>
      <NameDialog
        open={!!nameDialog}
        title={nameDialog?.title || ""}
        defaultValue={nameDialog?.defaultValue}
        onOk={(value) => { nameDialog?.onOk(value); }}
        onCancel={() => setNameDialog(null)}
      />
    </div>
    </>
  );
});

export default EditorPane;
