import { useState, forwardRef, useImperativeHandle, useCallback, useEffect, useRef, useMemo } from "react";
import { flushSync } from "react-dom";
import Editor from "@monaco-editor/react";
import FilesPanel from "./FilesPanel";
import BrowserView from "./BrowserView";
import type { BrowserViewHandle } from "./BrowserView";
import TerminalPane, { type DebugConsoleEntry, type OutputEntry, type ProblemEntry, type BrowserConsoleEntry } from "./TerminalPane";
import type { AgentTerminalBridge } from "./AgentTerminalBridge";
import { VFile, createFile, detectLanguage, fileIconUrl } from "./fileModel";
import FilePreview, { previewKindOf } from "./FilePreview";
import { readFileFromHandle, writeFileToHandle } from "./browserFs";
import { useResizable, ResizeHandle } from "../hooks/useResizable";
import NameDialog from "./NameDialog";
import ScmPanel from "./ScmPanel";
import SearchPanel from "./SearchPanel";
import SettingsDialog from "./SettingsDialog";
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
  applyAiFiles: (files: { name: string; content: string; fsPath?: string; isNew?: boolean }[]) => void;
  /** Apply agent file changes with original content for inline diff highlighting. */
  applyAgentFileChanges: (changes: { name: string; content: string; fsPath?: string; originalContent?: string | null }[]) => void;
  goToLine: (line: number) => void;
  goToBracket: () => void;
  setLanguage: (lang: string) => void;
  setIndent: (opts: { tabSize: number; insertSpaces: boolean }) => void;
  setLineEnding: (le: string) => void;
  setEncoding: (enc: string) => Promise<void>;
  getConsoleContext: () => string;
  /** Pre-fetch the file tree context from the backend. Call before getConsoleContext()
   *  to ensure the latest full/patch file tree is included in the snapshot. */
  fetchFileTreeContext: () => Promise<void>;
  executeBrowserAction: (toolName: string, params: Record<string, unknown>) => Promise<string>;
  getProjectFiles: () => Promise<string[]>;
  getFsBasePath: () => string;
  getActiveFilePath: () => string | null;
  /** Refresh the git status for untracked/modified markers. */
  refreshGitStatus?: () => Promise<void>;
  /** Close the active editor tab. */
  closeActiveTab: () => void;
  /** Accept agent changes for a file by its fsPath (clears diff decorations). */
  acceptAgentChange: (fsPath: string) => void;
  /** Reject agent changes for a file by its fsPath (restores original, clears decorations). */
  rejectAgentChange: (fsPath: string) => void;
  /** Switch active tab to a file by its fsPath. */
  openFileByFsPath: (fsPath: string, line?: number, query?: string) => void;
  /** Close a file tab by its fsPath. */
  closeFileByFsPath: (fsPath: string) => void;
  /** Rename a file tab by its old fsPath to a new fsPath. */
  renameFileByFsPath: (oldPath: string, newPath: string) => void;
  /** Close all open file tabs. */
  closeAllFiles: () => void;
}

export interface StatusBarState {
  cursorLine: number;
  cursorColumn: number;
  language: string;
  encoding: string;
  fsBasePath: string;
  hasFsRoot: boolean;
  hasEditor: boolean;
  /** Active file's LSP error message (e.g. binary not found, init timeout) */
  lspError?: string;
}

interface PendingProblemSelection {
  fileId?: string;
  filePath?: string;
  line: number;
  column: number;
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
  recentPaths?: string[];
  onOpenRecent?: (path: string) => void;
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
  /** Called when user clicks Accept on the agent diff banner */
  onBannerAcceptFile?: (filePath: string) => void;
  /** Called when user clicks Reject on the agent diff banner */
  onBannerRejectFile?: (filePath: string) => void;
  /** Agent ↔ terminal bridge — when agent runs a command it spawns in a real terminal */
  agentTerminalBridge?: AgentTerminalBridge;
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

// A contiguous git change relative to HEAD, used for the click-to-peek popup + revert.
interface GitHunk {
  kind: "added" | "modified" | "removed";
  newStart: number;   // first current-file line of the hunk (for removed: the surviving line where deleted lines used to be)
  newCount: number;   // number of current-file lines in the hunk (0 for a pure deletion)
  original: string[]; // HEAD lines that were removed/replaced (empty for a pure addition)
  current: string[];  // current lines that were added/changed (empty for a pure deletion)
}

// Normalize a filesystem path for comparison: unify separators and uppercase
// the Windows drive letter (git/Node/browser can disagree on drive-letter case).
function normPath(p: string | undefined | null): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, (_m, d) => d.toUpperCase() + ":");
}

// ── Breadcrumb symbol hierarchy ──────────────────────────────────────────────
// Build a NESTED symbol tree (top level > 2nd level > …) from source structure,
// so the breadcrumb can show only the symbols enclosing the current scroll line.

interface SymbolNode {
  name: string;
  line: number;
  endLine: number;
  depth: number;
  children: SymbolNode[];
}

// Void HTML elements (no closing tag) — used for markup nesting.
const HTML_VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function symbolRegexFor(language: string): RegExp | null {
  const symLangs = new Set([
    "typescript", "javascript", "python", "go", "rust", "java", "csharp",
    "c", "cpp", "php", "kotlin", "swift", "ruby",
  ]);
  if (symLangs.has(language)) {
    if (language === "python") return /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/;
    return new RegExp(
      "^\\s*(?:export\\s+|default\\s+|abstract\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|declare\\s+)*" +
      "(?:function\\*?\\s+|class\\s+|interface\\s+|enum\\s+|namespace\\s+)(\\w+)" +
      "|" +
      "^\\s*(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>"
    );
  }
  // CSS-family: selectors and at-rules (e.g. `.card`, `#app`, `@media`, `@keyframes x`)
  if (language === "css" || language === "scss" || language === "less") {
    return /^\s*((?:@[\w-]+[^{]*|[.#&:]*[\w-]+(?:[\s>+~,:.#&][\w-]+)*))\s*\{/;
  }
  return null;
}

/** Turn a regex match into a display name (differs per language family). */
function symbolNameFromMatch(language: string, m: RegExpExecArray): string {
  let name = (m[1] || m[2] || "").trim();
  const isCssFamily = language === "css" || language === "scss" || language === "less";
  if (isCssFamily && name.startsWith("@")) {
    const parts = name.split(/\s+/);
    name = parts[0] === "@keyframes" && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0];
  }
  return name;
}

// Match a markup symbol on a line: `tag#id` (id) > `tag.class` (class) > `<style>/<script>/<template>`.
// Breadcrumb shows these as the HTML outline, e.g. `div.gantt`, `style`, `script`.
function matchMarkupSymbol(line: string): { name: string } | null {
  const clean = line.replace(/<!--[\s\S]*?-->/g, "");
  const reTag = /<([\w-]+)((?:[^<>]*?))\/?\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = reTag.exec(clean))) {
    const full = m[0];
    if (full.startsWith("</")) continue;
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const id = /(?:^|\s)id\s*=\s*["']([^"']+)["']/.exec(attrs);
    if (id) return { name: `${tag}#${id[1]}` };
    const cls = /(?:^|\s)class\s*=\s*["']([^"']+)["']/.exec(attrs);
    if (cls) {
      const first = cls[1].trim().split(/\s+/)[0];
      if (first) return { name: `${tag}.${first}` };
    }
    if (tag === "style" || tag === "script" || tag === "template") {
      return { name: tag };
    }
  }
  return null;
}

/** Advance a tag stack over one line of markup (returns the new stack length). */
function scanMarkupTags(line: string, stack: string[]): number {
  const clean = line
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const reTag = /<\/?([\w-]+)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = reTag.exec(clean))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const rest = m[2].trim();
    if (full.startsWith("</")) {
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) stack.splice(idx);
    } else if (!HTML_VOID_TAGS.has(tag) && !rest.endsWith("/")) {
      stack.push(tag);
    }
  }
  return stack.length;
}

// Extract symbols with their nesting depth and line span.
function buildSymbolTree(content: string, language: string): SymbolNode[] {
  const isMarkup = language === "html" || language === "xml";
  const re = isMarkup ? null : symbolRegexFor(language);
  if (!re && !isMarkup) return [];
  const lines = content.split("\n");
  const lastLine = lines.length;
  const isPy = language === "python";

  const raws: SymbolNode[] = [];
  const open: SymbolNode[] = [];
  if (isPy) {
    let lastCodeIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue; // blank / comment: no nesting change
      const indent = (line.match(/^[ \t]*/) || [""])[0];
      const depth = indent.includes("\t") ? indent.length : Math.round(indent.length / 4);
      // Dedent closes any symbol at or below this indent.
      if (depth < lastCodeIndent) {
        for (const node of open) {
          if (node.endLine === -1 && node.depth >= depth) node.endLine = i;
        }
      }
      lastCodeIndent = depth;
      const m = re!.exec(line);
      if (m) {
        const node: SymbolNode = { name: symbolNameFromMatch(language, m), line: i + 1, depth, endLine: -1, children: [] };
        raws.push(node);
        open.push(node);
      }
    }
  } else if (isMarkup) {
    const tagStack: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const sym = matchMarkupSymbol(line);
      if (sym) {
        const node: SymbolNode = {
          name: sym.name,
          line: i + 1,
          depth: tagStack.length,
          endLine: -1,
          children: [],
        };
        raws.push(node);
        open.push(node);
      }
      const depth = scanMarkupTags(line, tagStack);
      // A symbol ends when the tag depth returns to its starting depth.
      for (const node of open) {
        if (node.endLine === -1 && depth <= node.depth) node.endLine = i + 1;
      }
    }
  } else {
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const startDepth = braceDepth;
      const m = re!.exec(line);
      if (m) {
        const node: SymbolNode = { name: symbolNameFromMatch(language, m), line: i + 1, depth: startDepth, endLine: -1, children: [] };
        raws.push(node);
        open.push(node);
      }
      const closes = (line.match(/}/g) || []).length;
      braceDepth += (line.match(/{/g) || []).length - closes;
      // A symbol ends when the brace depth returns to its starting depth.
      if (closes > 0) {
        for (const node of open) {
          if (node.endLine === -1 && braceDepth <= node.depth) node.endLine = i + 1;
        }
      }
    }
  }
  for (const node of open) if (node.endLine === -1) node.endLine = lastLine;

  // Assemble the tree: parent = nearest previous node whose span contains this one.
  const roots: SymbolNode[] = [];
  for (let i = 0; i < raws.length; i++) {
    const n = raws[i];
    let parent: SymbolNode | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const p = raws[j];
      if (p.line < n.line && p.depth < n.depth && n.line <= p.endLine) { parent = p; break; }
    }
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

// Breadcrumb trail at a given line: the nested symbols enclosing it, outermost first.
function symbolPathAtLine(nodes: SymbolNode[], line: number): SymbolNode[] {
  const path: SymbolNode[] = [];
  let cur = nodes;
  while (cur.length) {
    const hit = cur.find((n) => line >= n.line && line <= n.endLine);
    if (!hit) break;
    path.push(hit);
    cur = hit.children;
  }
  return path;
}

// Breadcrumb segments for the bar below the editor tabs:
// project-relative directories > file name > enclosing symbols at the scroll line.
function breadcrumbFor(
  file: VFile | undefined,
  fsBasePath: string,
  tree: SymbolNode[],
  line: number
): { label: string; kind: "dir" | "file" | "symbol"; line?: number }[] {
  if (!file) return [];
  const segs: { label: string; kind: "dir" | "file" | "symbol"; line?: number }[] = [];
  let rel = file.name;
  if (file._fsPath) {
    const norm = normPath(file._fsPath);
    const base = normPath(fsBasePath).replace(/\/+$/, "");
    rel = base && (norm === base || norm.startsWith(base + "/")) ? norm.slice(base.length + 1) : norm;
  }
  const parts = rel.split(/[/\\]/).filter(Boolean);
  parts.forEach((p, idx) => segs.push({ label: p, kind: idx === parts.length - 1 ? "file" : "dir" }));
  for (const s of symbolPathAtLine(tree, line)) {
    segs.push({ label: s.name, kind: "symbol", line: s.line });
  }
  return segs;
}

// Map LSP CompletionItemKind to Monaco CompletionItemKind
function mapLspKind(kind: number | undefined): number {
  // Monaco kind range: 0..27 (see monaco.languages.CompletionItemKind)
  // LSP kind uses same numbering as Monaco (0-based)
  if (typeof kind === "number") return Math.min(Math.max(kind, 0), 27);
  return 1; // Text
}

interface EditorViewHandle {
  focus: () => void;
  setPosition: (position: { lineNumber: number; column: number }) => void;
  revealPositionInCenter: (position: { lineNumber: number; column: number }) => void;
  onDidChangeCursorPosition: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => { dispose: () => void };
  getVisibleRanges?: () => { startLineNumber: number; endLineNumber: number }[];
  onDidScrollChange?: (cb: () => void) => { dispose: () => void };
  getModel?: () => any;
  deltaDecorations: (oldDecorations: string[], newDecorations: any[]) => string[];
}

// Module-level: track which languages have LSP completion providers registered
const lspRegistered = new Set<string>();

// Languages we do NOT send to the LSP diagnostics endpoint:
//  - Monaco validates these itself via its built-in workers (feeds markers through onValidate)
//  - or they have no meaningful diagnostics
const LSP_SKIP_LANGS = new Set<string>([
  "javascript", "typescript", "json", "jsonc", "css", "scss", "less", "html",
  "plaintext", "xml", "bat", "ini", "markdown",
]);



const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { fsRoot, fsBasePath, terminalVenvDir, terminalActivateScript, browserTabs, activeBrowserTabId,
    onActiveBrowserTabChange, onCloseBrowser, onBrowserTabClose, onAddBrowserTab,
    onBrowserTabUpdateLabel, onBrowserTabUpdateUrl, onBrowserNewTabFromLink,
    onOpenFolder, recentPaths, onOpenRecent,
    onCreateProject, onCreateFile, onOpenFile, onRefreshFs,
    terminalVisible, onCloseTerminal, onDetectUrl, debugEntries, onClearDebugEntries, outputEntries, onClearOutputEntries,
    onOpenDevtools, devtoolsForceKey, onStatusChange, onBannerAcceptFile, onBannerRejectFile, agentTerminalBridge }, ref
) {
  const [files, setFiles] = useState<VFile[]>([]);
  const [markersByFileId, setMarkersByFileId] = useState<Record<string, MarkerSnapshot[]>>({});
  const [markersByFsPath, setMarkersByFsPath] = useState<Record<string, { fsPath: string; markers: MarkerSnapshot[] }>>({});
  const [activeFileId, setActiveFileId] = useState<string>("");
  const activeFileIdRef = useRef(activeFileId);
  const browserTabsRef = useRef(browserTabs);
  browserTabsRef.current = browserTabs;
  const fsPathByFileIdRef = useRef<Record<string, string>>({});
  const lspDiagTimeoutsRef = useRef<Record<string, number>>({});
  // SSE connections: one EventSource per language
  const lspSseRef = useRef<Record<string, { es: EventSource; files: Set<string> }>>({});
  // Last content sent to LSP per file id (debounce)
  const lspContentRef = useRef<Record<string, string>>({});
  // Per-language LSP error messages.
  const lspErrorsRef = useRef<Record<string, string>>({});
  const editorByFileIdRef = useRef<Record<string, EditorViewHandle | null>>({});
  const pendingProblemSelectionRef = useRef<PendingProblemSelection | null>(null);
  const pendingSearchNavRef = useRef<{ fileId?: string; filePath?: string; line: number; query: string } | null>(null);
  const searchHighlightDecoRef = useRef<Record<string, string[]>>({});
  const { size: filePanelW, onMouseDown: onFilePanelDrag } = useResizable(200, 120, 500);
  const { size: termH, onMouseDown: onTermDrag } = useResizable(220, 80, 600, true);
  const [sidebarPanel, setSidebarPanel] = useState<string>("");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  useEffect(() => { settingsOpenRef.current = settingsOpen; }, [settingsOpen]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const browserViewRef = useRef<BrowserViewHandle>(null);
  const welcomeClickLockRef = useRef(0);
  const [browserConsoleMap, setBrowserConsoleMap] = useState<Record<string, BrowserConsoleEntry[]>>({});
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    defaultValue?: string;
    defaultExt?: string;
    extraValue?: string;
    type?: "file" | "folder";
    existingNames?: string[];
    onOk: (value: string, extra?: string) => void;
  } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [gitChanges, setGitChanges] = useState<Map<string, string>>(new Map()); // absolutePath → status letter
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set()); // file ids that have unsaved changes
  const [gitDiffs, setGitDiffs] = useState<Record<string, string>>({}); // fileId → unified diff text
  const diffDecorationsRef = useRef<Record<string, string[]>>({}); // fileId → decorationIds
  // fileId → (lineNumber → git hunk) used for click-to-peek + revert
  const gitHunksRef = useRef<Record<string, Map<number, GitHunk>>>({});
  // fileId → (lineNumber → diagnostics on that line) used for error/warning peek
  const markersByLineRef = useRef<Record<string, Map<number, MarkerSnapshot[]>>>({});
  // fileId → currently open inline peek (so it can be toggled/closed)
  const peekRef = useRef<Record<string, { line: number; zoneId: string } | null>>({});
  // fileId → { originalContent, newContent } for agent-pending inline diffs
  const [agentDiffs, setAgentDiffs] = useState<Record<string, { originalContent: string; newContent: string }>>({});
  const agentDiffsRef = useRef(agentDiffs);
  agentDiffsRef.current = agentDiffs;
  const agentDiffDecoRef = useRef<Record<string, string[]>>({}); // fileId → decorationIds
  // fileId → preview layout ("editor" | "split" | "preview") for previewable files
  const [previewModeByFile, setPreviewModeByFile] = useState<Record<string, "editor" | "split" | "preview">>({});
  // fileId → top visible line (breadcrumb follows scroll position)
  const [crumbLineByFile, setCrumbLineByFile] = useState<Record<string, number>>({});

  const handleWelcomeClick = useCallback((fn: () => void) => {
    const now = Date.now();
    if (now - welcomeClickLockRef.current < 800) return;
    welcomeClickLockRef.current = now;
    fn();
  }, []);

  // Jump the editor to a symbol (breadcrumb click).
  const goToSymbolLine = useCallback((fileId: string, line: number) => {
    setActiveFileId(fileId);
    requestAnimationFrame(() => {
      const ed = editorByFileIdRef.current[fileId];
      if (!ed) return;
      (ed as any).revealPositionInCenter?.({ lineNumber: line, column: 1 });
      (ed as any).focus?.();
    });
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (window.hDesktop?.openSettings) {
      window.hDesktop.openSettings();
    } else if (settingsOpenRef.current) {
      setSettingsOpen(false);
      setTimeout(() => setSettingsOpen(true), 0);
    } else {
      setSettingsOpen(true);
    }
  }, []);

  useEffect(() => {
    const handler = () => handleOpenSettings();
    window.addEventListener("open-settings", handler);
    return () => window.removeEventListener("open-settings", handler);
  }, [handleOpenSettings]);

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const f of files) {
      if (f._fsPath) map[f.id] = f._fsPath;
    }
    fsPathByFileIdRef.current = map;
  }, [files]);

  const syncProblemMarkersForFile = useCallback((fileId: string, modelOrEditor?: any) => {
    try {
      const monaco = (window as any).monaco;
      const model = modelOrEditor?.getModel ? modelOrEditor.getModel() : modelOrEditor || editorByFileIdRef.current[fileId]?.getModel?.();
      if (!monaco || !model?.uri) return;
      const seen = new Set<string>();
      const markers = (monaco.editor.getModelMarkers({ resource: model.uri }) as MarkerSnapshot[])
        .filter((marker) => {
          const code = typeof marker.code === "string" ? marker.code : marker.code?.value || "";
          const key = [
            marker.startLineNumber,
            marker.startColumn,
            marker.endLineNumber,
            marker.endColumn,
            marker.severity,
            marker.source || "",
            code,
            marker.message,
          ].join("|");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      setMarkersByFileId((prev) => ({ ...prev, [fileId]: markers }));
      const fsPath = fsPathByFileIdRef.current[fileId];
      if (fsPath) {
        const key = normPath(fsPath);
        setMarkersByFsPath((prev) => {
          const next = { ...prev };
          if (markers.length > 0) next[key] = { fsPath, markers };
          else delete next[key];
          return next;
        });
      }
    } catch { /* ignore marker sync issues */ }
  }, []);

  const clearScheduledLspDiagnostics = useCallback((fileId: string) => {
    const handle = lspDiagTimeoutsRef.current[fileId];
    if (handle !== undefined) {
      window.clearTimeout(handle);
      delete lspDiagTimeoutsRef.current[fileId];
    }
  }, []);

  const clearLspMarkersForFile = useCallback((fileId: string) => {
    try {
      const monaco = (window as any).monaco;
      const model = editorByFileIdRef.current[fileId]?.getModel?.();
      if (monaco && model) {
        monaco.editor.setModelMarkers(model, "lsp", []);
        syncProblemMarkersForFile(fileId, model);
      } else {
        setMarkersByFileId((prev) => ({ ...prev, [fileId]: [] }));
      }
    } catch { /* ignore marker clear issues */ }
  }, [syncProblemMarkersForFile]);

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
      const hunkMap = new Map<number, GitHunk>();
      if (diffText) {
        const lines = diffText.split("\n");
        let newLine = 0;
        // Accumulators for a contiguous run of removed (-) / added (+) lines
        let delBuf: string[] = [];
        let addStart = 0, addCount = 0;

        const pushGlyph = (line: number, kind: GitHunk["kind"], hunk: GitHunk) => {
          if (line < 1 || line > lineCount) return;
          hunkMap.set(line, hunk);
          if (kind === "removed") {
            newDecorations.push({
              range: new monaco.Range(line, 1, line, 1),
              options: {
                glyphMarginClassName: "git-removed-glyph",
                glyphMarginHoverMessage: { value: "Removed lines (click to view / revert)" },
                overviewRuler: { color: "#f85149", position: monaco.editor.OverviewRulerLane.Right },
              },
            });
          } else {
            const isAdded = kind === "added";
            newDecorations.push({
              range: new monaco.Range(line, 1, line, 1),
              options: {
                isWholeLine: true,
                linesDecorationsClassName: isAdded ? "git-added-line" : "git-modified-line",
                glyphMarginClassName: isAdded ? "git-added-glyph" : "git-modified-glyph",
                glyphMarginHoverMessage: { value: `${isAdded ? "Added" : "Modified"} lines (click to view / revert)` },
                overviewRuler: {
                  color: isAdded ? "#2ea043" : "#388bfd",
                  position: monaco.editor.OverviewRulerLane.Right,
                },
              },
            });
          }
        };

        const flush = () => {
          if (addCount > 0) {
            // Added (no removals) vs modified (removals replaced by additions)
            const kind: GitHunk["kind"] = delBuf.length > 0 ? "modified" : "added";
            const current: string[] = [];
            for (let i = 0; i < addCount; i++) {
              const ln = addStart + i;
              current.push(ln >= 1 && ln <= lineCount ? model.getLineContent(ln) : "");
            }
            const hunk: GitHunk = { kind, newStart: addStart, newCount: addCount, original: delBuf.slice(), current };
            for (let i = 0; i < addCount; i++) pushGlyph(addStart + i, kind, hunk);
          } else if (delBuf.length > 0) {
            // Pure deletion — mark the surviving line where the lines used to be
            const surviving = Math.min(Math.max(newLine, 1), lineCount);
            const hunk: GitHunk = { kind: "removed", newStart: surviving, newCount: 0, original: delBuf.slice(), current: [] };
            pushGlyph(surviving, "removed", hunk);
          }
          delBuf = []; addStart = 0; addCount = 0;
        };

        for (const line of lines) {
          if (line.startsWith("@@")) {
            flush();
            const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (m) newLine = parseInt(m[1], 10);
          } else if (line.startsWith("+++") || line.startsWith("---")) {
            continue;
          } else if (line.startsWith("+")) {
            if (addCount === 0) addStart = newLine;
            addCount++;
            newLine++;
          } else if (line.startsWith("-")) {
            delBuf.push(line.slice(1));
          } else if (line.startsWith("\\")) {
            continue; // "\ No newline at end of file"
          } else {
            flush();
            newLine++;
          }
        }
        flush();
      }
      gitHunksRef.current[fileId] = hunkMap;

      // ── Error/warning decorations (overview ruler + left gutter) ──
      const lineMarkers = new Map<number, MarkerSnapshot[]>();
      if (markers && markers.length > 0) {
        // Group diagnostics by line so the click-popup can show all of them.
        for (const m of markers) {
          if (m.startLineNumber > lineCount) continue;
          const isErrorRange = (m.severity || 0) === 8;
          const isWarningRange = (m.severity || 0) === 4;
          if (isErrorRange || isWarningRange) {
            const startLine = Math.max(1, Math.min(m.startLineNumber, lineCount));
            const endLine = Math.max(startLine, Math.min(m.endLineNumber || m.startLineNumber, lineCount));
            const startColumn = Math.max(1, m.startColumn || 1);
            const endColumn = Math.max(startColumn + (startLine === endLine ? 0 : 0), m.endColumn || startColumn + 1);
            newDecorations.push({
              range: new monaco.Range(startLine, startColumn, endLine, endColumn),
              options: {
                inlineClassName: isErrorRange ? "editor-problem-range-error" : "editor-problem-range-warning",
              },
            });
          }
          const arr = lineMarkers.get(m.startLineNumber) || [];
          arr.push(m);
          lineMarkers.set(m.startLineNumber, arr);
        }
        for (const [line, arr] of lineMarkers) {
          // Highest severity on the line wins for the glyph color.
          const top = Math.max(...arr.map((m) => m.severity || 0));
          const isError = top === 8;
          const isWarning = top === 4;
          if (!isError && !isWarning) continue;
          newDecorations.push({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              overviewRuler: {
                color: isError ? "#f85149" : "#d29922",
                // Lane 0 = Left (errors), Lane 1 = Center (warnings), avoid lane 2 (Right = git)
                position: isError ? monaco.editor.OverviewRulerLane.Left : monaco.editor.OverviewRulerLane.Center,
              },
              glyphMarginClassName: isError ? "error-glyph" : "warning-glyph",
            },
          });
        }
      }
      markersByLineRef.current[fileId] = lineMarkers;

      const ids = editor.deltaDecorations([], newDecorations);
      diffDecorationsRef.current[fileId] = ids;
    } catch { /* */ }
  }

  function closePeek(editor: any, fileId: string) {
    const existing = peekRef.current[fileId];
    if (existing) {
      editor.changeViewZones((acc: any) => acc.removeZone(existing.zoneId));
      peekRef.current[fileId] = null;
    }
  }

  // Render a single diff line, making blank lines and whitespace-only lines visible.
  function makeLineRow(text: string, cls: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "git-diff-peek-line " + cls;
    if (text.length === 0) {
      row.classList.add("peek-ws");
      row.textContent = "⏎"; // an empty / newline-only line
    } else if (text.trim().length === 0) {
      row.classList.add("peek-ws");
      row.textContent = "·".repeat(text.length); // whitespace-only → show as dots
    } else {
      row.textContent = text; // CSS white-space: pre preserves inner spacing
    }
    return row;
  }

  // Restore a hunk to its HEAD (original) state by editing the model in place.
  function revertHunk(editor: any, hunk: GitHunk) {
    const monaco = (window as any).monaco;
    const model = editor.getModel();
    if (!monaco || !model) return;
    const eol = model.getEOL();
    const lineCount = model.getLineCount();
    let range: any;
    let text: string;
    if (hunk.kind === "added") {
      // Delete the added lines entirely.
      const start = hunk.newStart;
      const end = hunk.newStart + hunk.newCount - 1;
      if (end >= lineCount) {
        const from = Math.max(1, start - 1);
        range = new monaco.Range(from, from < start ? model.getLineMaxColumn(from) : 1, end, model.getLineMaxColumn(end));
      } else {
        range = new monaco.Range(start, 1, end + 1, 1);
      }
      text = "";
    } else if (hunk.kind === "modified") {
      // Replace current lines with the original ones.
      const start = hunk.newStart;
      const end = hunk.newStart + hunk.newCount - 1;
      range = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
      text = hunk.original.join(eol);
    } else {
      // removed → re-insert the original lines where they used to be.
      const at = hunk.newStart;
      if (at > lineCount) {
        range = new monaco.Range(lineCount, model.getLineMaxColumn(lineCount), lineCount, model.getLineMaxColumn(lineCount));
        text = eol + hunk.original.join(eol);
      } else {
        range = new monaco.Range(at, 1, at, 1);
        text = hunk.original.join(eol) + eol;
      }
    }
    editor.executeEdits("git-revert", [{ range, text, forceMoveMarkers: true }]);
    editor.pushUndoStop?.();
  }

  // Click a glyph → show a popup. Git glyphs get Revert + Close; error/warning
  // glyphs get the diagnostic message(s) + Close. Both can appear together.
  function togglePeek(editor: any, fileId: string, line: number) {
    try {
      const existing = peekRef.current[fileId];
      if (existing) {
        editor.changeViewZones((acc: any) => acc.removeZone(existing.zoneId));
        peekRef.current[fileId] = null;
        if (existing.line === line) return; // clicking the same glyph closes it
      }
      const hunk = gitHunksRef.current[fileId]?.get(line);
      const diags = markersByLineRef.current[fileId]?.get(line) || [];
      if (!hunk && diags.length === 0) return;

      const dom = document.createElement("div");
      dom.className = "editor-peek";
      // The view-zone layer sits *below* Monaco's `.monaco-mouse-cursor-text`
      // overlay, which would otherwise win the hit-test and swallow the press.
      // Give the popup its own raised stacking context so it receives clicks.
      dom.style.position = "relative";
      dom.style.zIndex = "30";
      dom.style.pointerEvents = "auto";
      let rows = 0;

      // Diagnostics section
      if (diags.length) {
        const sec = document.createElement("div");
        sec.className = "editor-peek-section";
        for (const d of diags) {
          const sev = d.severity === 8 ? "error" : d.severity === 4 ? "warning" : "info";
          const r = document.createElement("div");
          r.className = "peek-diag peek-diag-" + sev;
          const icon = sev === "error" ? "✕" : sev === "warning" ? "▲" : "ℹ";
          const src = d.source ? `  (${d.source})` : "";
          r.textContent = `${icon} ${d.message}${src}`;
          sec.appendChild(r);
          rows++;
        }
        dom.appendChild(sec);
      }

      // Git diff section
      if (hunk) {
        const sec = document.createElement("div");
        sec.className = "editor-peek-section";
        const title = document.createElement("div");
        title.className = "peek-git-title";
        title.textContent =
          hunk.kind === "added" ? "Added lines" :
          hunk.kind === "removed" ? "Removed lines (original)" : "Modified — original ↓";
        sec.appendChild(title); rows++;
        // Show original (HEAD) lines for removed/modified.
        for (const t of hunk.original) { sec.appendChild(makeLineRow(t, "peek-old")); rows++; }
        // For added/modified, also show the current lines.
        if (hunk.kind !== "removed") {
          if (hunk.kind === "modified") {
            const sub = document.createElement("div");
            sub.className = "peek-git-title peek-git-subtitle";
            sub.textContent = "current ↓";
            sec.appendChild(sub); rows++;
          }
          for (const t of hunk.current) { sec.appendChild(makeLineRow(t, "peek-new")); rows++; }
        }
        dom.appendChild(sec);
      }

      // Button bar. NOTE: act on `mousedown`, not `click` — Monaco re-lays-out
      // view zones on the editor mousedown that precedes the click and can
      // recreate this DOM node, so a `click` handler would never fire.
      const bar = document.createElement("div");
      bar.className = "editor-peek-bar";
      const makeBtn = (label: string, cls: string, action: () => void) => {
        const b = document.createElement("button");
        b.className = "peek-btn " + cls;
        b.textContent = label;
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          action();
        });
        return b;
      };
      if (hunk) {
        bar.appendChild(makeBtn("Revert", "peek-btn-revert", () => {
          revertHunk(editor, hunk);
          closePeek(editor, fileId);
        }));
      }
      bar.appendChild(makeBtn("Close", "peek-btn-close", () => closePeek(editor, fileId)));
      dom.appendChild(bar);
      rows++;

      const zone: any = {
        afterLineNumber: line,
        heightInPx: rows * 20 + 24, // initial estimate
        domNode: dom,
      };
      editor.changeViewZones((acc: any) => {
        const zoneId = acc.addZone(zone);
        peekRef.current[fileId] = { line, zoneId };
        // After the DOM reflows, re-layout the zone to its true content height
        // so the button bar can never be clipped (and stays clickable).
        requestAnimationFrame(() => {
          const cur = peekRef.current[fileId];
          if (!cur || cur.zoneId !== zoneId) return;
          const h = dom.scrollHeight;
          if (h && Math.abs(h - zone.heightInPx) > 2) {
            editor.changeViewZones((acc2: any) => {
              zone.heightInPx = h;
              acc2.layoutZone(zoneId);
            });
          }
        });
      });
    } catch { /* */ }
  }

  // Fetch git status — reusable so saveFile can refresh after write
  const refreshGitStatus = useCallback(async () => {
    if (!fsBasePath) { setGitChanges(new Map()); return; }
    try {
      const res = await fetch(`/api/git/status?path=${encodeURIComponent(fsBasePath)}`);
      const data = await res.json();
      if (!data.ok) return;
      const gitRoot: string = data.gitRoot || fsBasePath;
      const m = new Map<string, string>();
      for (const c of ([] as Array<{ path: string; status: string }>).concat(data.staged || [], data.unstaged || [])) {
        const absPath = normPath(gitRoot.replace(/\/$/, "") + "/" + c.path);
        const existing = m.get(absPath);
        const prio: Record<string, number> = { "M": 4, "A": 3, "D": 2, "U": 1, "?": 0 };
        const s = c.status[0];
        if (!existing || (prio[s] || 0) > (prio[existing] || 0)) {
          m.set(absPath, s);
        }
      }
      setGitChanges(m);
      // Clear _isNew on any file now tracked by git.
      // (Git status takes over the "U" / "M" / "A" marker.)
      setFiles((prev) => {
        let changed = false;
        const updated = prev.map((f) => {
          if (!f._isNew || !f._fsPath) return f;
          if (m.has(normPath(f._fsPath))) { changed = true; return { ...f, _isNew: false }; }
          return f;
        });
        return changed ? updated : prev;
      });
    } catch { /* */ }
  }, [fsBasePath]);

  useEffect(() => { refreshGitStatus(); }, [refreshGitStatus]);

  // Clear open files when folder is closed
  const prevBasePathRef = useRef(fsBasePath);
  useEffect(() => {
    if (prevBasePathRef.current && !fsBasePath) {
      setFiles([]);
      setDirtyFiles(new Set());
    }
    prevBasePathRef.current = fsBasePath;
  }, [fsBasePath]);

  // Safety: clear activeFileId when active file is removed from files (close folder, closeAllFiles, etc.)
  useEffect(() => {
    if (activeFileId && activeFileId !== BROWSER_EDITOR_TAB_ID && !files.some((f) => f.id === activeFileId)) {
      setActiveFileId(browserTabs.length > 0 ? BROWSER_EDITOR_TAB_ID : "");
      setCursorPos({ line: 1, column: 1 });
    }
  }, [files, activeFileId, browserTabs.length]);

  // Fetch git diff for active file
  useEffect(() => {
    const f = files.find((x) => x.id === activeFileId);
    if (!f?._fsPath) { setGitDiffs((prev) => { const n = { ...prev }; delete n[activeFileId]; return n; }); return; }
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

  // ── SSE-based real-time diagnostics (VS Code style) ──
  // One persistent SSE connection per language receives publishDiagnostics
  // as the LSP server emits them — no polling, no fingerprinting.

  // Return a unique key for an SSE connection: rootPath + language.
  const sseKey = useCallback((language: string) => {
    return `${fsBasePath || ""}::${language}`;
  }, [fsBasePath]);

  // Open/close SSE connections as files open/close per language.
  useEffect(() => {
    if (!fsBasePath) return;
    const wanted: Record<string, Set<string>> = {}; // sseKey → Set<fileId>
    for (const f of files) {
      if (!f._fsPath || LSP_SKIP_LANGS.has(f.language)) continue;
      const k = sseKey(f.language);
      if (!wanted[k]) wanted[k] = new Set();
      wanted[k].add(f.id);
    }
    // Close connections for languages that no longer have files.
    for (const k of Object.keys(lspSseRef.current)) {
      if (!wanted[k]) {
        lspSseRef.current[k].es.close();
        delete lspSseRef.current[k];
      }
    }
    // Open/update connections for each language.
    for (const [k, fileIds] of Object.entries(wanted)) {
      const lang = k.split("::")[1];
      if (lspSseRef.current[k]) {
        lspSseRef.current[k].files = fileIds;
      } else {
        const es = new EventSource(`/api/lsp/watch?rootPath=${encodeURIComponent(fsBasePath)}&language=${encodeURIComponent(lang)}`);
        lspSseRef.current[k] = { es, files: fileIds };
      }
      // Always refresh onmessage so it sees the latest files (not a stale closure).
      const entry = lspSseRef.current[k];
      entry.es.onmessage = (e) => {
        try {
          const { uri, markers } = JSON.parse(e.data);
          const normUri = uri.toLowerCase().replace(/\\/g, "/");
          for (const f of files) {
            if (!f._fsPath) continue;
            const fNorm = normPath(f._fsPath).toLowerCase().replace(/\\/g, "/");
            if (normUri.includes(fNorm) || fNorm.includes(normUri.replace("file:///", ""))) {
              const editor = editorByFileIdRef.current[f.id] as any;
              const model = editor?.getModel?.();
              const monaco = (window as any).monaco;
              if (monaco && model) {
                monaco.editor.setModelMarkers(model, "lsp", markers);
                syncProblemMarkersForFile(f.id, model);
              } else {
                setMarkersByFileId((prev) => ({ ...prev, [f.id]: markers }));
              }
              break;
            }
          }
        } catch { /* ignore parse errors */ }
      };

      if (!entry.es.onerror) {
        entry.es.onerror = () => {
          lspErrorsRef.current[lang] = "LSP connection lost";
        };
      }
    }
  }, [files, fsBasePath, sseKey, syncProblemMarkersForFile]);

  // Send didChange notifications to LSP on content change (fire-and-forget).
  // Debounced per file: 250ms for active, 700ms for background.
  useEffect(() => {
    if (!fsBasePath) return;
    const openIds = new Set(files.map(f => f.id));
    // Clear timeouts for closed files
    for (const id of Object.keys(lspDiagTimeoutsRef.current)) {
      if (!openIds.has(id)) clearScheduledLspDiagnostics(id);
    }
    for (const id of Object.keys(lspContentRef.current)) {
      if (!openIds.has(id)) delete lspContentRef.current[id];
    }
    for (const f of files) {
      if (!f._fsPath || LSP_SKIP_LANGS.has(f.language)) continue;
      if (lspContentRef.current[f.id] === f.content) continue;
      lspContentRef.current[f.id] = f.content;
      clearScheduledLspDiagnostics(f.id);
      const delay = f.id === activeFileId ? 250 : 700;
      lspDiagTimeoutsRef.current[f.id] = window.setTimeout(() => {
        fetch("/api/lsp/diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rootPath: fsBasePath,
            language: f.language,
            filePath: f._fsPath,
            text: f.content,
          }),
        }).catch(() => {
          lspErrorsRef.current[f.language] = "LSP server unreachable";
        });
      }, delay);
    }
  }, [files, activeFileId, fsBasePath, clearScheduledLspDiagnostics]);

  // Cleanup on unmount
  useEffect(() => () => {
    for (const handle of Object.values(lspDiagTimeoutsRef.current)) {
      window.clearTimeout(handle);
    }
    for (const entry of Object.values(lspSseRef.current)) {
      entry.es.close();
    }
  }, []);

  // Clean up LSP error state for languages that no longer have open files.
  useEffect(() => {
    const openLanguages = new Set(files.map(f => f.language));
    for (const lang of Object.keys(lspErrorsRef.current)) {
      if (!openLanguages.has(lang)) delete lspErrorsRef.current[lang];
    }
  }, [files]);

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

  // Ref tracking tabId → last known URL so we can detect page navigations.
  const browserUrlRef = useRef<Record<string, string>>({});

  // Clear console entries when a tab navigates to a new URL (page load).
  useEffect(() => {
    for (const tab of browserTabs) {
      const prev = browserUrlRef.current[tab.id];
      if (prev !== undefined && prev !== tab.url) {
        setBrowserConsoleMap((m) => ({ ...m, [tab.id]: [] }));
      }
      browserUrlRef.current[tab.id] = tab.url;
    }
  }, [browserTabs]);

  // Clear console entries when switching to a different browser tab.
  useEffect(() => {
    if (!activeBrowserTabId) return;
    setBrowserConsoleMap((prev) => {
      if (prev[activeBrowserTabId]?.length) return { ...prev, [activeBrowserTabId]: [] };
      return prev;
    });
  }, [activeBrowserTabId]);

  // Directly remove console entries for a closed browser tab — no dependence on
  // effect timing. Called from the BrowserView close button (individual tab)
  // and from closeTab for the editor-level browser tab.
  const handleBrowserTabCloseInner = useCallback((id: string) => {
    setBrowserConsoleMap((prev) => { const n = { ...prev }; delete n[id]; return n; });
    onBrowserTabClose(id);
  }, [onBrowserTabClose]);

  // Clear all browser console entries when the user navigates away from the
  // browser editor tab (switches to a file).
  useEffect(() => {
    if (activeFileId && activeFileId !== BROWSER_EDITOR_TAB_ID) {
      setBrowserConsoleMap((prev) => {
        const count = Object.values(prev).reduce((s, e) => s + e.length, 0);
        return count > 0 ? {} : prev;
      });
    }
  }, [activeFileId]);

  const sidebarItems = [
    { id: "files", icon: "files", label: "Explorer", title: "Explorer (Ctrl+Shift+E)" },
    { id: "search", icon: "search", label: "Search", title: "Search (Ctrl+Shift+F)" },
    { id: "scm", icon: "source-control", label: "Source Control", title: "Source Control (Ctrl+Shift+G)" },
    { id: "browser", icon: "globe", label: "Preview", title: "Browser Preview" },
    { id: "debug", icon: "debug-alt", label: "Debug", title: "Run and Debug (Ctrl+Shift+D)" },
    { id: "remote", icon: "remote", label: "Remote Explorer", title: "Remote Explorer" },
    { id: "extensions", icon: "extensions", label: "Extensions", title: "Extensions (Ctrl+Shift+X)" },
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

  // Nested symbol tree for the active file (breadcrumb follows scroll position).
  const activeSymbolTree = useMemo(
    () => (activeFile ? buildSymbolTree(activeFile.content, activeFile.language) : []),
    [activeFile?.id, activeFile?.content]
  );
  const breadcrumbSegs = useMemo(
    () => breadcrumbFor(activeFile, fsBasePath, activeSymbolTree, crumbLineByFile[activeFile?.id || ""] || 1),
    [activeFile, fsBasePath, activeSymbolTree, crumbLineByFile]
  );

  const handleSetLanguage = useCallback((lang: string) => {
    if (!activeFileId) return;
    setFiles((prev) => prev.map((f) =>
      f.id === activeFileId ? { ...f, language: lang } : f
    ));
  }, [activeFileId]);
  const hasFsRoot = !!(fsRoot && fsRoot.length > 0) || !!fsBasePath;
  const hasEditor = activeFileId !== "" && activeFileId !== BROWSER_EDITOR_TAB_ID;

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
      lspError: lspErrorsRef.current[activeLanguage],
    });
  }, [cursorPos.line, cursorPos.column, activeLanguage, activeEncoding, fsBasePath, hasFsRoot, hasEditor, lspErrorsRef, onStatusChange]);

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
    const openPathKeys = new Set<string>();
    for (const file of files) {
      if (file._fsPath) openPathKeys.add(normPath(file._fsPath));
    }
    const entries: ProblemEntry[] = [];
    for (const file of files) {
      const markers = markersByFileId[file.id] || [];
      for (let index = 0; index < markers.length; index++) {
        const marker = markers[index];
        entries.push({
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
        });
      }
    }
    for (const [pathKey, snap] of Object.entries(markersByFsPath)) {
      if (openPathKeys.has(pathKey)) continue;
      const name = snap.fsPath.split(/[/\\]/).pop() || snap.fsPath;
      for (let index = 0; index < snap.markers.length; index++) {
        const marker = snap.markers[index];
        entries.push({
          id: `${pathKey}-${index}-${marker.startLineNumber}-${marker.startColumn}-${marker.message}`,
          fileId: `fs:${pathKey}`,
          fileName: name,
          filePath: snap.fsPath,
          severity: severityMap[marker.severity] || "info",
          message: marker.message,
          line: marker.startLineNumber,
          column: marker.startColumn,
          endLine: marker.endLineNumber,
          endColumn: marker.endColumn,
          source: marker.source,
          code: typeof marker.code === "string" ? marker.code : marker.code?.value,
        });
      }
    }
    return entries;
  }, [files, markersByFileId, markersByFsPath]);

  // Diagnostic error/warning maps for file tree rendering
  const diagnosticErrors = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of problemEntries) {
      if (p.severity === "error" && p.filePath) {
        const k = normPath(p.filePath);
        map.set(k, (map.get(k) || 0) + 1);
      }
    }
    return map;
  }, [problemEntries]);

  const diagnosticWarnings = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of problemEntries) {
      if (p.severity === "warning" && p.filePath) {
        const k = normPath(p.filePath);
        map.set(k, (map.get(k) || 0) + 1);
      }
    }
    return map;
  }, [problemEntries]);

  useEffect(() => { activeFileIdRef.current = activeFileId; }, [activeFileId]);

  useEffect(() => {
    const pending = pendingProblemSelectionRef.current;
    if (!pending) return;
    const resolvedFileId = pending.fileId
      || files.find((f) => f._fsPath && pending.filePath && normPath(f._fsPath) === normPath(pending.filePath))?.id;
    if (!resolvedFileId || resolvedFileId !== activeFileId) return;
    pending.fileId = resolvedFileId;
    const editor = editorByFileIdRef.current[resolvedFileId];
    if (!editor) return;
    const position = { lineNumber: pending.line, column: pending.column };
    requestAnimationFrame(() => {
      editor.revealPositionInCenter(position);
      editor.setPosition(position);
      editor.focus();
      pendingProblemSelectionRef.current = null;
    });
  }, [activeFileId, files]);

  // Consume pending search navigation: scroll to line and highlight match
  useEffect(() => {
    const pending = pendingSearchNavRef.current;
    if (!pending) return;
    const resolvedFileId = pending.fileId
      || files.find((f) => f._fsPath && pending.filePath && normPath(f._fsPath) === normPath(pending.filePath))?.id;
    if (!resolvedFileId || resolvedFileId !== activeFileId) return;
    pending.fileId = resolvedFileId;
    const editor = editorByFileIdRef.current[resolvedFileId];
    if (!editor) return;
    requestAnimationFrame(() => {
      const model = (editor as any).getModel?.();
      if (!model) { pendingSearchNavRef.current = null; return; }
      const maxLine = model.getLineCount?.() || 1;
      const line = Math.min(pending.line, maxLine);
      editor.revealPositionInCenter({ lineNumber: line, column: 1 });
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();

      // Highlight the matched text on the line
      const monaco = (window as any).monaco;
      if (monaco && pending.query) {
        // Clear previous search highlights for this file
        const oldIds = searchHighlightDecoRef.current[resolvedFileId];
        if (oldIds?.length) editor.deltaDecorations(oldIds, []);

        const lineContent = model.getLineContent(line);
        const lowerLine = lineContent.toLowerCase();
        const lowerQuery = pending.query.toLowerCase();
        let idx = 0;
        const newDecos: any[] = [];
        while ((idx = lowerLine.indexOf(lowerQuery, idx)) !== -1) {
          newDecos.push({
            range: new monaco.Range(line, idx + 1, line, idx + 1 + pending.query.length),
            options: { inlineClassName: "search-result-highlight", overviewRuler: { color: "#4D6BFE", position: monaco.editor.OverviewRulerLane.Center } },
          });
          idx += pending.query.length;
        }
        if (newDecos.length) {
          const ids = editor.deltaDecorations([], newDecos);
          searchHighlightDecoRef.current[resolvedFileId] = ids;
        }
      }
      pendingSearchNavRef.current = null;
    });
  }, [activeFileId, files]);

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
    // Resolve relative paths against the project root (search returns project-relative paths,
    // but the server's CWD is the H directory, not the opened project).
    let resolvedPath = filePath;
    if (!filePath.match(/^[a-zA-Z]:[\\/]/) && !filePath.startsWith("\\\\") && !filePath.startsWith("/") && fsBasePath) {
      resolvedPath = fsBasePath.replace(/[/\\]$/, "") + "/" + filePath;
    }
    const target = normPath(resolvedPath);
    const name = filePath.split(/[/\\]/).pop() || "untitled";
    // Re-read from disk so external edits (saved via Ctrl+S / agent tools) are reflected.
    // Even if a tab is already open, fetch fresh content from disk.
    const existing = files.find((f) => normPath(f._fsPath) === target)
      || files.find((f) => f.name === name);

    if (existing && existing._isNew) {
      setFiles((prev) => prev.map((f) => f.id === existing.id ? { ...f, _isNew: false } : f));
    }

    // Always re-read from disk (skip handles — those are browser File System API).
    // readErr holds the message when the disk read fails (e.g. file deleted),
    // so the fallback below can show a clear error instead of "undefined".
    let readErr = "";
    if (!handle && !existing?._isNew) {
      try {
        const res = await fetch(`/api/fs/read?path=${encodeURIComponent(resolvedPath)}`);
        if (!res.ok) throw new Error(`Unable to read file (HTTP ${res.status}): ${resolvedPath}`);
        const data = await res.json();
        let openId = existing?.id || "";
        if (existing) {
          setFiles((prev) => prev.map((f) =>
            f.id === existing.id ? { ...f, content: data.content, _encoding: data.encoding || "utf8" } : f
          ));
          openId = existing.id;
        } else {
          const f = createFile(name);
          f._fsPath = resolvedPath;
          f.content = data.content;
          f._encoding = data.encoding || "utf8";
          openId = f.id;
          setFiles((prev) => {
            // Dedup: if another tab with the same name was added while fetch was in flight
            const dup = prev.find((x) => normPath(x._fsPath) === target);
            if (dup) {
              openId = dup.id;
              return prev.map((x) => x.id === dup.id ? { ...x, content: data.content } : x);
            }
            return [...prev, f];
          });
        }
        setActiveFileId(openId);
        return;
      } catch (err) {
        // Read failed — fall through to create tab with error content.
        // Don't clobber an already-open tab's (possibly unsaved) content.
        if (existing) {
          setActiveFileId(existing.id);
          return;
        }
        readErr = err instanceof Error ? err.message : String(err);
      }
    }

    if (existing) {
      setActiveFileId(existing.id);
      return;
    }
    try {
      const f = createFile(name);
      f._fsPath = resolvedPath;
      if (handle) {
        f.content = await readFileFromHandle(handle);
        f._fsHandle = handle;
      } else if (readErr) {
        f.content = readErr;
      } else {
        const res = await fetch(`/api/fs/read?path=${encodeURIComponent(resolvedPath)}`);
        if (!res.ok) {
          let detail = "";
          try { const e = await res.json(); detail = e?.error || ""; } catch { /* */ }
          f.content = `Unable to read file (HTTP ${res.status}): ${detail || resolvedPath}`;
        } else {
          const data = await res.json();
          f.content = data.content;
          f._encoding = data.encoding || "utf8";
        }
      }
      // Authoritative check against the *latest* tab list to avoid a duplicate
      // when two reads for the same file are in flight (rapid clicks).
      let openId = f.id;
      setFiles((prev) => {
        const already = prev.find((x) => normPath(x._fsPath) === target);
        if (already) { openId = already.id; return prev; }
        return [...prev, f];
      });
      setActiveFileId(openId);
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

  const applyAiFiles_activeRef = useRef<string>("");
  const applyAiFiles = useCallback((aiFiles: { name: string; content: string; fsPath?: string; isNew?: boolean }[]) => {
    applyAiFiles_activeRef.current = "";
    flushSync(() => {
      setFiles((prev) => {
        const updated = [...prev];
        let newFileId = "";
        let modifiedFileId = "";
        for (const af of aiFiles) {
          const target = af.fsPath ? normPath(af.fsPath) : "";
          const existing = target
            ? updated.find((f) => normPath(f._fsPath) === target)
            : undefined;
          const byName = !existing && target
            ? updated.find((f) => f.name === af.name)
            : undefined;
          const match = existing || byName;
          if (match) {
            match.content = af.content;
            if (byName && af.fsPath) {
              const fp = normPath(af.fsPath);
              match._fsPath = /^[A-Z]:/i.test(fp) || fp.startsWith("/") ? fp : normPath(fsBasePath + "/" + fp);
            }
            if (match._fsPath) {
              fetch("/api/fs/write", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: match._fsPath, content: af.content }),
              }).catch(() => {});
            }
            const editor = editorByFileIdRef.current[match.id];
            if (editor) {
              try {
                const model = (editor as any).getModel?.();
                if (model && model.getValue() !== af.content) {
                  model.setValue(af.content);
                }
              } catch { /* editor not fully initialized yet */ }
            }
            clearLspMarkersForFile(match.id);
            modifiedFileId = modifiedFileId || match.id;
          } else {
            const f = createFile(af.name, af.content);
            if (af.fsPath) {
              const fp = normPath(af.fsPath);
              f._fsPath = /^[A-Z]:/i.test(fp) || fp.startsWith("/") ? fp : normPath(fsBasePath + "/" + fp);
            }
            if (af.isNew) f._isNew = true;
            updated.push(f);
            newFileId = newFileId || f.id;
          }
        }
        applyAiFiles_activeRef.current = newFileId || modifiedFileId;
        return updated;
      });
    });
    const activeId = applyAiFiles_activeRef.current;
    if (activeId) setActiveFileId(activeId);
  }, [fsBasePath, clearLspMarkersForFile]);

  const agentDiffsPendingRef = useRef<Record<string, { originalContent: string; newContent: string }>>({});
  // Keep a ref of latest files so applyAgentFileChanges can resolve diffs immediately
  const filesRef = useRef<VFile[]>([]);
  filesRef.current = files;

  // Apply agent diff decorations (inline red/green backgrounds)
  const applyAgentDiffDecorations = useCallback((editor: any, fileId: string, diff: { originalContent: string; newContent: string } | undefined) => {
    try {
      const monaco = (window as any).monaco;
      if (!monaco) return;
      const model = editor.getModel();
      if (!model) return;

      // Clear previous agent decorations for this file
      const old = agentDiffDecoRef.current[fileId];
      if (old?.length) editor.deltaDecorations(old, []);

      if (!diff) { agentDiffDecoRef.current[fileId] = []; return; }

      const oLines = diff.originalContent.split("\n");
      const nLines = diff.newContent.split("\n");
      // LCS for diff
      const m = oLines.length, n = nLines.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
          dp[i][j] = oLines[i - 1] === nLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

      // Backtrack
      const ops: (" " | "-" | "+")[] = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oLines[i - 1] === nLines[j - 1]) { ops.unshift(" "); i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.unshift("+"); j--; }
        else { ops.unshift("-"); i--; }
      }

      const decos: any[] = [];
      let newLine = 1;
      let firstChangeLine = 0;
      for (const op of ops) {
        if (op === "-") {
          if (!firstChangeLine) firstChangeLine = newLine;
          decos.push({
            range: new monaco.Range(newLine, 1, newLine, Number.MAX_SAFE_INTEGER),
            options: {
              isWholeLine: true,
              className: "agent-diff-removed-line",
              overviewRuler: { color: "#f85149", position: monaco.editor.OverviewRulerLane.Center },
            },
          });
        } else if (op === "+") {
          if (!firstChangeLine) firstChangeLine = newLine;
          decos.push({
            range: new monaco.Range(newLine, 1, newLine, Number.MAX_SAFE_INTEGER),
            options: {
              isWholeLine: true,
              className: "agent-diff-added-line",
              overviewRuler: { color: "#4ec94e", position: monaco.editor.OverviewRulerLane.Center },
            },
          });
          newLine++;
        } else {
          newLine++;
        }
      }

      const ids = editor.deltaDecorations([], decos);
      agentDiffDecoRef.current[fileId] = ids;

      // Scroll to the first changed line so the user sees what was modified
      if (firstChangeLine > 0) {
        editor.revealLineInCenterIfOutsideViewport?.(firstChangeLine);
        // fallback if the method isn't available
        editor.revealLineInCenter?.(firstChangeLine);
      }
    } catch { /* */ }
  }, []);

  const applyAgentFileChanges = useCallback((changes: { name: string; content: string; fsPath?: string; originalContent?: string | null }[]) => {
    applyAiFiles(changes);
    const pending: Record<string, { originalContent: string; newContent: string }> = {};
    for (const c of changes) {
      pending[c.name] = { originalContent: c.originalContent || "", newContent: c.content };
    }
    if (Object.keys(pending).length === 0) return;

    // Apply diff decorations immediately for files whose editors are mounted.
    // (requestAnimationFrame would race with the React useEffect that clears
    // agentDiffsPendingRef, losing all decoration data.)
    const latestFiles = filesRef.current;
    const idMap: Record<string, { originalContent: string; newContent: string }> = {};
    const stillPending: Record<string, { originalContent: string; newContent: string }> = {};
    for (const diffName of Object.keys(pending)) {
      const match = latestFiles.find((f) => f.name === diffName);
      if (match) {
        idMap[match.id] = pending[diffName];
        const editor = editorByFileIdRef.current[match.id];
        if (editor) {
          applyAgentDiffDecorations(editor, match.id, pending[diffName]);
        }
      } else {
        // File not yet in the files list (e.g. openFsFile fetch still in-flight).
        // Stash in pending ref so the files useEffect picks them up when it arrives.
        stillPending[diffName] = pending[diffName];
      }
    }
    if (Object.keys(idMap).length > 0) {
      setAgentDiffs(idMap);
    }
    if (Object.keys(stillPending).length > 0) {
      agentDiffsPendingRef.current = { ...agentDiffsPendingRef.current, ...stillPending };
    }
  }, [applyAiFiles, applyAgentDiffDecorations]);

  // Resolve pending agent diffs when files state updates
  useEffect(() => {
    const pending = agentDiffsPendingRef.current;
    if (Object.keys(pending).length === 0) return;
    const idMap: Record<string, { originalContent: string; newContent: string }> = {};
    for (const f of files) {
      if (pending[f.name]) idMap[f.id] = pending[f.name];
    }
    if (Object.keys(idMap).length > 0) {
      setAgentDiffs(idMap);
      agentDiffsPendingRef.current = {};
    }
  }, [files]);

  // Accept all agent changes for a file — clear decorations, keep content
  const acceptAgentChanges = useCallback((fileId: string) => {
    setAgentDiffs((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  }, []);

  // Resolve fsPath to fileId and accept
  const acceptAgentChangeByPath = useCallback((fsPath: string) => {
    const f = files.find((x) => x._fsPath && normPath(x._fsPath) === normPath(fsPath));
    if (f) acceptAgentChanges(f.id);
  }, [files, acceptAgentChanges]);

  // Reject all agent changes for a file — restore original content, clear decorations
  const rejectAgentChanges = useCallback((fileId: string) => {
    const diff = agentDiffs[fileId];
    if (!diff) return;
    const f = files.find((x) => x.id === fileId);
    // Revert file on disk first
    if (f?._fsPath) {
      fetch("/api/fs/write", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: f._fsPath, content: diff.originalContent }),
      }).then((r) => {
        if (!r.ok) { console.error("Banner reject write failed:", r.status); return; }
        onRefreshFs?.();
      }).catch((err) => { console.error("Banner reject failed:", err); });
    }
    // Always clear diff UI and restore editor content
    setFiles((prev) => prev.map((x) => x.id !== fileId ? x : { ...x, content: diff.originalContent }));
    setAgentDiffs((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  }, [agentDiffs, files, onRefreshFs]);

  // Resolve fsPath to fileId and reject
  const rejectAgentChangeByPath = useCallback((fsPath: string) => {
    const f = files.find((x) => x._fsPath && normPath(x._fsPath) === normPath(fsPath));
    if (f) rejectAgentChanges(f.id);
  }, [files, rejectAgentChanges]);

  // Switch to file by fsPath, optionally scroll to line and highlight query.
  // Uses filesRef instead of the closure `files` so calls immediately following
  // applyAiFiles / applyAgentFileChanges see the just-opened tab.
  const openFileByFsPath = useCallback((fsPath: string, line?: number, query?: string) => {
    let resolvedFsPath = fsPath;
    if (!fsPath.match(/^[a-zA-Z]:[\\/]/) && !fsPath.startsWith("\\\\") && !fsPath.startsWith("/") && fsBasePath) {
      resolvedFsPath = fsBasePath.replace(/[/\\]$/, "") + "/" + fsPath;
    }
    if (line && query) {
      pendingSearchNavRef.current = { filePath: resolvedFsPath, line, query };
    }
    const f = filesRef.current.find((x) => x._fsPath && normPath(x._fsPath) === normPath(resolvedFsPath));
    if (f) {
      setActiveFileId(f.id);
      if (line && query) pendingSearchNavRef.current!.fileId = f.id;
      return;
    }
    openFsFile(fsPath);
  }, [fsBasePath, openFsFile]);

  // Apply agent diff decorations when agent changes or active file changes
  useEffect(() => {
    const editor = editorByFileIdRef.current[activeFileId];
    if (editor) applyAgentDiffDecorations(editor, activeFileId, agentDiffs[activeFileId]);
  }, [activeFileId, agentDiffs, applyAgentDiffDecorations]);

  // Build a text snapshot of the entire console state (problems, debug, output,
  // browser console, DOM tree) so DeepSeek can see what's happening.
  // File tree context is pre-fetched via fetchFileTreeContext() before each agent run
  // and cached here. First call sends full tree; subsequent calls send patches only.
  const fileTreeContextRef = useRef("");

  const fetchFileTreeContext = useCallback(async () => {
    if (!fsBasePath) { fileTreeContextRef.current = ""; return; }
    try {
      const res = await fetch("/api/file-tracking/file-tree-context");
      if (!res.ok) return;
      const data = await res.json();
      fileTreeContextRef.current = data.text || "";
    } catch { /* non-fatal */ }
  }, [fsBasePath]);

  const getConsoleContext = useCallback((): string => {
    const lines: string[] = [];
    lines.push("### CONSOLE STATE SNAPSHOT ###");

    // ── File tree context (pre-fetched by fetchFileTreeContext) ──
    if (fileTreeContextRef.current) {
      lines.push(fileTreeContextRef.current);
      lines.push("");
    }

    // ── Problems (errors/warnings from editor) ──
    const problems = problemEntries;
    const errs = problems.filter((p) => p.severity === "error").length;
    const warns = problems.filter((p) => p.severity === "warning").length;
    const infos = problems.filter((p) => p.severity === "info" || p.severity === "hint").length;
    if (errs + warns + infos > 0) {
      lines.push(`Problems: ${errs} errors, ${warns} warnings, ${infos} info/hints`);
      const sample = problems.slice(0, 15);
      for (const p of sample) {
        lines.push(`  ${p.severity.toUpperCase()}: ${p.fileName}:${p.line} – ${p.message}`);
      }
      if (problems.length > 15) lines.push(`  ... and ${problems.length - 15} more`);
    } else {
      lines.push("Problems: none");
    }

    // ── Debug Console (WebSocket events from test runs / server) ──
    const dEntries = (debugEntries || []).length;
    if (dEntries > 0) {
      lines.push(`Debug Console: ${dEntries} entries`);
      const sample = (debugEntries || []).slice(-10);
      for (const d of sample) {
        const txt = (d.text || "").slice(0, 200);
        lines.push(`  [${d.source}] ${txt}`);
      }
    } else {
      lines.push("Debug Console: empty");
    }

    // ── Output ──
    const oEntries = (outputEntries || []).length;
    if (oEntries > 0) {
      lines.push(`Output: ${oEntries} entries`);
      const sample = (outputEntries || []).slice(-10);
      for (const o of sample) {
        lines.push(`  [${o.kind}] ${(o.text || "").slice(0, 200)}`);
      }
    } else {
      lines.push("Output: empty");
    }

    // ── Browser Console ──
    const activeBrowserEntries = browserConsoleMap[activeBrowserTabId] || [];
    const totalBrowserEntries = Object.values(browserConsoleMap).reduce((s, e) => s + e.length, 0);
    if (totalBrowserEntries > 0) {
      lines.push(`Browser Console: ${totalBrowserEntries} entries total (active tab: ${activeBrowserEntries.length})`);
      const sample = activeBrowserEntries.slice(-10);
      for (const b of sample) {
        const txt = (b.text || "").slice(0, 200);
        const src = b.source === "domNode" ? `DOM` : `console.${b.level}`;
        const timeStr = b.time ? new Date(b.time).toISOString().slice(11, 19) : "?";
        lines.push(`  [${timeStr}] ${src} – ${txt}`);
      }
    } else {
      lines.push("Browser Console: empty");
    }
    // ── Current browser tab(s) ──
    if (browserTabs.length > 0) {
      lines.push("Browser tabs:");
      for (const t of browserTabs) {
        const isActive = t.id === activeBrowserTabId ? " [ACTIVE]" : "";
        lines.push(`  ${t.url || "(new tab)"}${isActive}`);
      }
    } else {
      lines.push("Browser: no tabs open");
    }

    // ── Files ──
    lines.push(`Open files: ${files.length} (active: ${activeFile?.name || "none"})`);
    for (const f of files.slice(0, 10)) {
      lines.push(`  ${f.name}${f.id === activeFileId ? " *ACTIVE*" : ""}${dirtyFiles.has(f.id) ? " [unsaved]" : ""}`);
    }

    // ── Git status on active file ──
    if (activeFile?._fsPath) {
      const gs = gitChanges.get(normPath(activeFile._fsPath));
      if (gs) lines.push(`Git: ${activeFile.name} is '${gs}' (${gs === "M" ? "modified" : gs === "A" ? "added" : gs === "D" ? "deleted" : gs === "?" ? "untracked" : "unknown"})`);
    }

    return lines.join("\n");
  }, [problemEntries, debugEntries, outputEntries, browserConsoleMap, activeBrowserTabId, browserTabs, files, activeFileId, activeFile, dirtyFiles, gitChanges]);

  // Execute a browser tool on behalf of the agent.
  const executeBrowserAction = useCallback(async (toolName: string, params: Record<string, unknown>): Promise<string> => {
    // browser_navigate doesn't need an existing loaded page — it creates/opens a tab
    if (toolName === "browser_navigate") {
      const url = String(params.url || "");
      let parsed: URL;
      try { parsed = new URL(url); } catch { return `Blocked: invalid URL "${url}".`; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `Blocked: only http/https URLs are allowed (got "${parsed.protocol}").`;
      }
      if (browserTabs.length === 0) {
        onBrowserNewTabFromLink?.(url);
      } else {
        const tabId = activeBrowserTabId || browserTabs[0]?.id;
        if (tabId) onBrowserTabUpdateUrl?.(tabId, url);
      }
      setActiveFileId(BROWSER_EDITOR_TAB_ID);
      // Wait for React to mount the BrowserView so subsequent tools work.
      // Poll browserViewRef for up to 2s after tab creation.
      const start = Date.now();
      while (!browserViewRef.current && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (browserViewRef.current) {
        return `Navigating to ${url}. Browser ready.`;
      }
      return `Navigating to ${url} (browser view still initializing — call browser_info to confirm).`;
    }

    // For tools that need a loaded page, wait briefly for browser view to be ready
    const bv = (() => {
      if (browserViewRef.current) return browserViewRef.current;
      // Browser view may not be mounted yet — often happens after a tab
      // was just created by browser_navigate. Return clear guidance.
      return null;
    })();
    if (!bv) return "Browser not available. Use browser_navigate first to open a URL, then retry this tool.";
    switch (toolName) {
      case "browser_screenshot": return bv.getPageSnapshot();
      case "browser_get_dom": return bv.getIndexedDom();
      case "browser_type": await bv.typeIntoElement(Number(params.index || 0), String(params.text || "")); return `Typed "${params.text}" into element.`;
      case "browser_clear": return bv.clearElement(Number(params.index || 0));
      case "browser_wait": {
        const selector = String(params.selector || "");
        if (!selector) return "Error: selector is required.";
        const timeout = Number(params.timeoutMs) || 5000;
        return bv.waitForElement(selector, timeout);
      }
      case "browser_click":
        if (params.index != null) return bv.clickElement(Number(params.index));
        return bv.clickCoords(Number(params.x || 0), Number(params.y || 0));
      case "browser_right_click":
        if (params.index != null) return bv.rightClickElement(Number(params.index));
        return bv.rightClick(Number(params.x || 0), Number(params.y || 0));
      case "browser_move_mouse": return bv.moveMouse(Number(params.x || 0), Number(params.y || 0));
      case "browser_scroll": return bv.scrollPage(Number(params.x || 0), Number(params.y || 0), params.to as string | undefined);
      case "browser_press_key": return bv.pressKey(String(params.key || ""));
      case "browser_upload_file": return bv.uploadFile(Number(params.index || 0), (params.paths as string[]) || []);
      case "browser_console": return bv.getConsoleEntries();
      case "browser_request_errors": return bv.getRequestErrors();
      case "browser_info": return bv.getInfo();
      case "browser_select": return bv.selectOption(Number(params.index || 0), params.value as string | undefined, params.label as string | undefined);
      case "read_problems": return getConsoleContext();
      default: return `Unknown browser tool: ${toolName}`;
    }
  }, [browserTabs, activeBrowserTabId, onBrowserNewTabFromLink, onBrowserTabUpdateUrl]);

  // Flat list of project-file paths for the agent's file-mention autocomplete.
  const getProjectFiles = useCallback(async (): Promise<string[]> => {
    if (fsBasePath) {
      try {
        const res = await fetch(`/api/fs/list-recursive?path=${encodeURIComponent(fsBasePath)}`);
        const data = await res.json();
        return (data.files || []) as string[];
      } catch { return []; }
    }
    return [];
  }, [fsBasePath]);

  const getFsBasePath = useCallback((): string => fsBasePath, [fsBasePath]);

  const newFilePaths = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      if (f._isNew && f._fsPath) s.add(normPath(f._fsPath));
    }
    return s;
  }, [files]);

  const scmBadgeCount = useMemo(() => gitChanges.size + newFilePaths.size, [gitChanges, newFilePaths]);

  useImperativeHandle(ref, () => ({
    getCode, getFiles: () => files, applyAiFiles, applyAgentFileChanges,
    acceptAgentChange: acceptAgentChangeByPath,
    rejectAgentChange: rejectAgentChangeByPath,
    openFileByFsPath,
    closeFileByFsPath,
    renameFileByFsPath,
    goToLine: handleGoToLine, goToBracket: handleGoToBracket,
    setLanguage: handleSetLanguage, setIndent: handleIndentChange,
    setLineEnding: handleLineEnding, setEncoding,
    getConsoleContext, fetchFileTreeContext, executeBrowserAction, getProjectFiles, getFsBasePath,
    getActiveFilePath: () => {
      const f = files.find((x) => x.id === activeFileIdRef.current);
      return f?._fsPath || null;
    },
    refreshGitStatus,
    closeActiveTab: () => {
      if (!activeFileIdRef.current) return;
      const id = activeFileIdRef.current;
      if (id === BROWSER_EDITOR_TAB_ID) {
        onCloseBrowser();
        setBrowserConsoleMap({});
        setActiveFileId(files[0]?.id || "");
        return;
      }
      setMarkersByFileId((prev) => { const next = { ...prev }; delete next[id]; return next; });
      delete editorByFileIdRef.current[id];
      if (pendingProblemSelectionRef.current?.fileId === id) {
        pendingProblemSelectionRef.current = null;
      }
      const idx = files.findIndex((f) => f.id === id);
      const remaining = files.filter((f) => f.id !== id);
      const nextId = remaining.length > 0
        ? remaining[Math.min(Math.max(idx, 0), Math.max(0, remaining.length - 1))]?.id || ""
        : (browserTabsRef.current.length > 0 ? BROWSER_EDITOR_TAB_ID : "");
      setFiles(remaining);
      setActiveFileId(nextId);
    },
    closeAllFiles: () => {
      setFiles([]);
      setDirtyFiles(new Set());
    },
  }), [getCode, files, applyAiFiles, applyAgentFileChanges, acceptAgentChangeByPath, rejectAgentChangeByPath, openFileByFsPath, handleGoToLine, handleGoToBracket, handleSetLanguage, handleIndentChange, handleLineEnding, setEncoding, getConsoleContext, executeBrowserAction, getProjectFiles, getFsBasePath, refreshGitStatus, onCloseBrowser]);

  const updateFile = useCallback((id: string, content: string) => {
    setDirtyFiles((prev) => { const next = new Set(prev); next.add(id); return next; });
    setFiles((prev) => prev.map((f) =>
      f.id !== id ? f : { ...f, content }
    ));
  }, []);

  const saveFile = useCallback(async (id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    // Attempt the write; only mark clean / refresh git when it actually succeeded.
    try {
      if (f._fsHandle) {
        await writeFileToHandle(f._fsHandle, f.content);
      } else if (f._fsPath) {
        const res = await fetch("/api/fs/write", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: f._fsPath, content: f.content }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `Save failed (${res.status})`);
        }
      }
    } catch (err) {
      console.error("Failed to save file:", err);
      return; // keep dirty flag so the user knows it wasn't saved
    }
    setDirtyFiles((prev) => { const next = new Set(prev); next.delete(id); return next; });
    // Refresh git status so tab markers (M/A/D/U) and file-tree markers update after save
    refreshGitStatus();
    // Refresh git diff for this specific file too
    if (f._fsPath) {
      fetch(`/api/git/diff?path=${encodeURIComponent(fsBasePath)}&file=${encodeURIComponent(f._fsPath)}`)
        .then(r => r.json())
        .then(data => {
          if (data.ok && data.diff) setGitDiffs(prev => ({ ...prev, [id]: data.diff }));
          else setGitDiffs(prev => { const n = { ...prev }; delete n[id]; return n; });
        })
        .catch(() => {});
    }
  }, [files, refreshGitStatus, fsBasePath]);

  // Auto-save: persist dirty files to disk after 1.5s of inactivity
  const autoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    if (dirtyFiles.size === 0) return;
    for (const id of dirtyFiles) {
      // Clear existing timer for this file
      if (autoSaveTimers.current[id]) {
        clearTimeout(autoSaveTimers.current[id]);
      }
      // Schedule a new auto-save
      autoSaveTimers.current[id] = setTimeout(() => {
        saveFile(id);
        delete autoSaveTimers.current[id];
      }, 1500);
    }
    // Cleanup old timers for files no longer dirty
    for (const id of Object.keys(autoSaveTimers.current)) {
      if (!dirtyFiles.has(id)) {
        clearTimeout(autoSaveTimers.current[id]);
        delete autoSaveTimers.current[id];
      }
    }
    return () => {
      // Cleanup all timers on unmount
      for (const id of Object.keys(autoSaveTimers.current)) {
        clearTimeout(autoSaveTimers.current[id]);
      }
    };
  }, [dirtyFiles, saveFile]);

  // Ctrl+S save (immediate, bypasses debounce)
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

  const updateProblemMarkers = useCallback((fileId: string, _markers: readonly MarkerSnapshot[]) => {
    syncProblemMarkersForFile(fileId);
  }, [syncProblemMarkersForFile]);

  const handleSelectProblem = useCallback(async (problem: ProblemEntry) => {
    const existing = files.find((f) => f.id === problem.fileId)
      || files.find((f) => f._fsPath && problem.filePath && normPath(f._fsPath) === normPath(problem.filePath));
    pendingProblemSelectionRef.current = {
      fileId: existing?.id,
      filePath: problem.filePath,
      line: problem.line,
      column: problem.column,
    };

    if (existing) {
      setActiveFileId(existing.id);
      const editor = editorByFileIdRef.current[existing.id];
      if (editor && activeFileIdRef.current === existing.id) {
        const position = { lineNumber: problem.line, column: problem.column };
        requestAnimationFrame(() => {
          editor.revealPositionInCenter(position);
          editor.setPosition(position);
          editor.focus();
          pendingProblemSelectionRef.current = null;
        });
      }
      return;
    }

    if (problem.filePath) {
      await openFsFile(problem.filePath);
      return;
    }

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
  }, [files, openFsFile]);

  const addFile = useCallback(async (parentDir?: string) => {
    const targetDir = parentDir || fsBasePath || "";
    let existingNames: string[] = [];
    if (targetDir) {
      try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(targetDir)}`);
        const data = await res.json();
        existingNames = (data.entries || []).map((e: { name: string }) => e.name);
      } catch { /* ignore */ }
    }
    setNameDialog({
      title: "New File",
      type: "file",
      extraValue: targetDir,
      existingNames,
      onOk: async (name) => {
        if (targetDir) {
          const sep = targetDir.includes("/") ? "/" : "\\";
          const filePath = targetDir + sep + name;
          try {
            await fetch("/api/fs/create-file", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: filePath, content: "" }),
            });
          } catch { /* ignore */ }
          await onRefreshFs();
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
      }
    });
  }, [fsBasePath, onRefreshFs]);

  const addDir = useCallback(async (parentDir?: string) => {
    const targetDir = parentDir || fsBasePath || "";
    let existingNames: string[] = [];
    if (targetDir) {
      try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(targetDir)}`);
        const data = await res.json();
        existingNames = (data.entries || []).map((e: { name: string }) => e.name);
      } catch { /* ignore */ }
    }
    setNameDialog({
      title: "New Folder",
      type: "folder",
      extraValue: targetDir,
      existingNames,
      onOk: async (name) => {
        const sep = targetDir.includes("/") ? "/" : "\\";
        const dirPath = targetDir + sep + name;
        try {
          await fetch("/api/fs/mkdir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: dirPath }),
          });
        } catch { /* ignore */ }
        await onRefreshFs();
        setNameDialog(null);
      }
    });
  }, [fsBasePath, onRefreshFs]);

  const closeTab = useCallback((id: string) => {
    if (id === BROWSER_EDITOR_TAB_ID) {
      onCloseBrowser();
      setBrowserConsoleMap({});
      if (activeFileIdRef.current === id) setActiveFileId(files[0]?.id || "");
      return;
    }
    clearScheduledLspDiagnostics(id);
    delete lspContentRef.current[id];
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
        setActiveFileId(next?.id || (browserTabsRef.current.length > 0 ? BROWSER_EDITOR_TAB_ID : ""));
      } else if (
        activeFileIdRef.current &&
        activeFileIdRef.current !== BROWSER_EDITOR_TAB_ID &&
        !remaining.some((f) => f.id === activeFileIdRef.current)
      ) {
        setActiveFileId(remaining[0]?.id || (browserTabsRef.current.length > 0 ? BROWSER_EDITOR_TAB_ID : ""));
      }
      return remaining;
    });
  }, [clearScheduledLspDiagnostics, files, onCloseBrowser]);

  const closeFileByFsPath = useCallback((fsPath: string) => {
    const f = files.find((x) => x._fsPath && normPath(x._fsPath) === normPath(fsPath));
    if (f) closeTab(f.id);
  }, [files, closeTab]);

  const renameFileByFsPath = useCallback((oldPath: string, newPath: string) => {
    const newName = newPath.split(/[/\\]/).pop() || newPath;
    setFiles((prev) => {
      let changed = false;
      const updated = prev.map((f) => {
        if (f._fsPath && normPath(f._fsPath) === normPath(oldPath)) {
          changed = true;
          return { ...f, name: newName, _fsPath: newPath, language: detectLanguage(newName) };
        }
        return f;
      });
      return changed ? updated : prev;
    });
  }, []);

  const renameFile = useCallback((id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    const dotIdx = f.name.lastIndexOf(".");
    const baseName = dotIdx > 0 ? f.name.slice(0, dotIdx) : f.name;
    const ext = dotIdx > 0 ? f.name.slice(dotIdx + 1) : "";
    setNameDialog({ title: "Rename", defaultValue: baseName, defaultExt: ext, type: "file", onOk: (newName) => {
      if (newName !== f.name) {
        setFiles((prev) => prev.map((x) =>
          x.id === id ? { ...x, name: newName, language: detectLanguage(newName) } : x
        ));
      }
      setNameDialog(null);
    }});
  }, [files]);

  const handleFsDelete = useCallback(async (targetPath: string) => {
    try {
      const res = await fetch("/api/fs/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath }),
      });
      if (!res.ok) { console.error("Delete API failed:", res.status); return; }
      await onRefreshFs();
      // Close any open tabs for files inside the deleted path
      setFiles((prev) => prev.filter((f) => !(f._fsPath && normPath(f._fsPath).startsWith(normPath(targetPath)))));
      if (selectedFolder === targetPath) setSelectedFolder(null);
    } catch (err) { console.error("handleFsDelete error:", err); }
  }, [onRefreshFs, selectedFolder]);

  const handleFsRename = useCallback((oldPath: string, isDirectory: boolean) => {
    const name = oldPath.split(/[/\\]/).pop() || "item";
    const doRename = async (newName: string) => {
      if (newName === name) { setNameDialog(null); return; }
      const parent = oldPath.replace(/[/\\][^/\\]*$/, "");
      const newPath = parent + (oldPath.includes("/") ? "/" : "\\") + newName;
      try {
        await fetch("/api/fs/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldPath, newPath }) });
      } catch { /* ignore */ }
      onRefreshFs();
      if (selectedFolder === oldPath) setSelectedFolder(newPath);
      // Update any open tabs that reference the old path
      setFiles((prev) => {
        let changed = false;
        const updated = prev.map((f) => {
          if (f._fsPath && normPath(f._fsPath) === normPath(oldPath)) {
            changed = true;
            return { ...f, name: newName, _fsPath: newPath, language: detectLanguage(newName) };
          }
          return f;
        });
        return changed ? updated : prev;
      });
      setNameDialog(null);
    };
    if (isDirectory) {
      setNameDialog({ title: "Rename", defaultValue: name, onOk: doRename });
    } else {
      const dotIdx = name.lastIndexOf(".");
      const baseName = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx + 1) : "";
      setNameDialog({ title: "Rename", defaultValue: baseName, defaultExt: ext, type: "file", onOk: doRename });
    }
  }, [onRefreshFs, selectedFolder]);

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
              <i className={`codicon codicon-${item.icon}`} />
              {item.id === "scm" && scmBadgeCount > 0 && (
                <span className="activity-bar-badge">{scmBadgeCount}</span>
              )}
            </button>
          ))}
          <div className="activity-bar-spacer" />
          <button className="activity-bar-btn" title="Manage" onClick={handleOpenSettings}><i className="codicon codicon-settings-gear" /></button>
        </div>
        {sidebarVisible && sidebarPanel && sidebarPanel !== "browser" && sidebarPanel !== "files" && sidebarPanel !== "scm" && sidebarPanel !== "search" && (
          <div className="sidebar-placeholder">
            <div className="sidebar-placeholder-text">{sidebarItems.find((i) => i.id === sidebarPanel)?.label || ""}</div>
            {sidebarPanel === "search" && <div className="placeholder-sub">Search across files coming soon</div>}
            {sidebarPanel === "debug" && <div className="placeholder-sub">Debug console coming soon</div>}
            {sidebarPanel === "remote" && <div className="placeholder-sub">Remote connections coming soon</div>}
            {sidebarPanel === "extensions" && <div className="placeholder-sub">Extension marketplace coming soon</div>}
          </div>
        )}
        {sidebarVisible && sidebarPanel === "scm" && <ScmPanel fsBasePath={fsBasePath} newFilePaths={newFilePaths} onOpenFile={openFileByFsPath} />}
        <div className="editor-welcome">
          <div className="welcome-logo">H</div>
          <div className="welcome-subtitle">Powered by DeepSeek</div>
          <div className="welcome-actions">
            <button className="welcome-btn" onClick={() => handleWelcomeClick(onOpenFolder)}>
              <span className="welcome-btn-icon">📂</span>
              <span className="welcome-btn-text"><strong>Open Folder</strong><small>Open an existing project from your drive</small></span>
            </button>
            <button className="welcome-btn" onClick={() => handleWelcomeClick(onOpenFile)}>
              <span className="welcome-btn-icon">📄</span>
              <span className="welcome-btn-text"><strong>Open File</strong><small>Open a single file from your drive</small></span>
            </button>
            <button className="welcome-btn" onClick={() => handleWelcomeClick(onCreateProject)}>
              <span className="welcome-btn-icon">🆕</span>
              <span className="welcome-btn-text"><strong>New Project</strong><small>Create an empty folder for your project</small></span>
            </button>
            <button className="welcome-btn" onClick={() => handleWelcomeClick(onCreateFile)}>
              <span className="welcome-btn-icon">📝</span>
              <span className="welcome-btn-text"><strong>New File</strong><small>Create a new file in the current folder</small></span>
            </button>
          </div>
          {recentPaths && recentPaths.length > 0 && onOpenRecent && (
            <div className="welcome-recent">
              <div className="welcome-recent-title">Recent</div>
              {recentPaths.map((p) => (
                <button key={p} className="welcome-btn welcome-recent-btn" onClick={() => handleWelcomeClick(() => onOpenRecent(p))}>
                  <span className="welcome-btn-icon">📁</span>
                  <span className="welcome-btn-text">
                    <strong>{p.split(/[/\\]/).pop() || p}</strong>
                    <small>{p}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
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
        defaultExt={nameDialog?.defaultExt || ""}
        extraValue={nameDialog?.extraValue || ""}
        type={nameDialog?.type}
        existingNames={nameDialog?.existingNames}
        onOk={(value, extra) => { nameDialog?.onOk(value, extra); }}
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
            <i className={`codicon codicon-${item.icon}`} />
            {item.id === "scm" && scmBadgeCount > 0 && (
              <span className="activity-bar-badge">{scmBadgeCount}</span>
            )}
          </button>
        ))}
        <div className="activity-bar-spacer" />
        <button className="activity-bar-btn" title="Manage" onClick={handleOpenSettings}><i className="codicon codicon-settings-gear" /></button>
      </div>
      {sidebarVisible && sidebarPanel === "files" && (
        <>
          <FilesPanel
            files={files}
            activeFileId={activeFileId}
            onSelect={setActiveFileId}
            onAdd={addFile}
            onAddFolder={addDir}
            onDelete={(id) => closeTab(id)}
            onRename={renameFile}
            selectedFolder={selectedFolder}
            onSelectFolder={setSelectedFolder}
            onFsDelete={handleFsDelete}
            onFsRename={handleFsRename}
            activeFilePath={activeFile?._fsPath || null}
            fsRoot={fsRoot}
            fsBasePath={fsBasePath}
            onOpenFsFile={openFsFile}
            onOpenFsFolder={onOpenFolder}
            onRefreshFs={onRefreshFs}
            width={filePanelW}
            gitChanges={gitChanges}
            newFilePaths={newFilePaths}
            diagnosticErrors={diagnosticErrors}
            diagnosticWarnings={diagnosticWarnings}
          />
          <ResizeHandle onMouseDown={onFilePanelDrag} />
        </>
      )}
      {sidebarVisible && sidebarPanel === "search" && (
        <SearchPanel fsBasePath={fsBasePath} onOpenFile={openFileByFsPath} />
      )}
      {sidebarVisible && sidebarPanel && sidebarPanel !== "files" && sidebarPanel !== "browser" && sidebarPanel !== "scm" && sidebarPanel !== "search" && (
        <div className="sidebar-placeholder">
          <div className="sidebar-placeholder-text">{sidebarItems.find((i) => i.id === sidebarPanel)?.label || ""}</div>
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
      {sidebarVisible && sidebarPanel === "scm" && <ScmPanel fsBasePath={fsBasePath} newFilePaths={newFilePaths} onOpenFile={openFileByFsPath} />}
      <div className="ide-editor-area">
        <div className="editor-tabs">
          {files.length === 0 && !hasBrowserTabs && (
            <div className="editor-tab tab-hint">Open a file from the sidebar to begin</div>
          )}
          {files.map((f) => {
            const fileMarkers = markersByFileId[f.id] || [];
            const errCount = fileMarkers.filter((m) => m.severity === 8).length;
            const warnCount = fileMarkers.filter((m) => m.severity === 4).length;
            const hasError = errCount > 0;
            const hasWarning = warnCount > 0;
            const gitStatus = f._fsPath ? gitChanges.get(normPath(f._fsPath)) || "" : "";
            const gitCls = gitStatus === "?" ? "u" : gitStatus.toLowerCase();
            const isNew = !!f._isNew;
            const isUntracked = gitStatus === "?" || (isNew && !gitStatus); // green "U" + green name
            return (
            <button key={f.id} className={`editor-tab${f.id === activeFileId ? " active" : ""}`} onClick={() => setActiveFileId(f.id)}>
              {dirtyFiles.has(f.id) && <span className="tab-dirty-dot" title="Unsaved">●</span>}
              {(gitStatus || isNew) && <span className={`tab-git-marker${isUntracked ? " tab-git-u" : ` tab-git-${gitCls}`}`} title={isUntracked ? "Untracked" : `git: ${gitStatus}`}>{isUntracked ? "U" : `${gitStatus} `}</span>}
              <span className={`tab-name${hasError ? " tab-name-err" : ""}${!hasError && hasWarning ? " tab-name-warn" : ""}${isUntracked ? " tab-name-new" : ""}`}>{f.name}</span>
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
        {activeFile && (() => {
          const kind = previewKindOf(activeFile);
          const mode = previewModeByFile[activeFile.id] || "editor";
          return (
            <div className="editor-breadcrumb-bar">
              <div className="editor-breadcrumb">
                {breadcrumbSegs.map((seg, i) => (
                  <span key={i} className="editor-breadcrumb-seg">
                    {i > 0 && <span className="editor-breadcrumb-sep"><i className="codicon codicon-chevron-right" /></span>}
                    <button
                      className={`editor-breadcrumb-item ${seg.kind}`}
                      title={seg.kind === "dir" ? seg.label : seg.kind === "file" ? seg.label : `Go to ${seg.label} (line ${seg.line})`}
                      onClick={() => {
                        if (seg.kind === "file") setActiveFileId(activeFile.id);
                        else if (seg.kind === "symbol" && seg.line) goToSymbolLine(activeFile.id, seg.line);
                      }}
                    >
                      <i className={`codicon codicon-${seg.kind === "dir" ? "folder" : seg.kind === "file" ? "file-code" : "symbol-method"}`} />
                      {seg.label}
                    </button>
                  </span>
                ))}
              </div>
              <div className="editor-breadcrumb-actions">
                {kind && (
                  <div className="editor-preview-toggle">
                    <button className={mode === "editor" ? "active" : ""} onClick={() => setPreviewModeByFile((p) => ({ ...p, [activeFile.id]: "editor" }))} title="Editor view">
                      <i className="codicon codicon-code" /> Editor
                    </button>
                    <button className={mode === "split" ? "active" : ""} onClick={() => setPreviewModeByFile((p) => ({ ...p, [activeFile.id]: "split" }))} title="Editor and preview side by side">
                      <i className="codicon codicon-split-horizontal" /> Split
                    </button>
                    <button className={mode === "preview" ? "active" : ""} onClick={() => setPreviewModeByFile((p) => ({ ...p, [activeFile.id]: "preview" }))} title="Preview only">
                      <i className="codicon codicon-eye" /> Preview
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        <div className="editor-main" style={{ flex: 1, overflow: "hidden" }}>
          {/* ── Agent diff accept/reject banner ── */}
          {agentDiffs[activeFileId] && (
            <div className="agent-diff-banner">
              <span className="agent-diff-banner-icon"><i className="codicon codicon-diff-modified" /></span>
              <span className="agent-diff-banner-text">AI modified this file</span>
              <div className="agent-diff-banner-actions">
                <button className="agent-diff-banner-btn accept" onClick={() => {
                  const fp = activeFile?._fsPath;
                  if (fp) onBannerAcceptFile?.(fp);
                }}>
                  <i className="codicon codicon-check" /> Accept
                </button>
                <button className="agent-diff-banner-btn reject" onClick={() => {
                  const fp = activeFile?._fsPath;
                  if (fp) onBannerRejectFile?.(fp);
                }}>
                  <i className="codicon codicon-close" /> Reject
                </button>
              </div>
            </div>
          )}
          <div className="editor-container">
            {showWelcomeInEditor && (
              <div className="editor-welcome">
                <div className="welcome-logo">H</div>
                <div className="welcome-subtitle">Powered by DeepSeek</div>
                <div className="welcome-actions">
                  <button className="welcome-btn" onClick={() => handleWelcomeClick(onOpenFolder)}>
                    <span className="welcome-btn-icon">📂</span>
                    <span className="welcome-btn-text"><strong>Open Folder</strong><small>Open an existing project from your drive</small></span>
                  </button>
                  <button className="welcome-btn" onClick={() => handleWelcomeClick(onOpenFile)}>
                    <span className="welcome-btn-icon">📄</span>
                    <span className="welcome-btn-text"><strong>Open File</strong><small>Open a single file from your drive</small></span>
                  </button>
                  <button className="welcome-btn" onClick={() => handleWelcomeClick(onCreateProject)}>
                    <span className="welcome-btn-icon">🆕</span>
                    <span className="welcome-btn-text"><strong>New Project</strong><small>Create an empty folder for your project</small></span>
                  </button>
                  <button className="welcome-btn" onClick={() => handleWelcomeClick(onCreateFile)}>
                    <span className="welcome-btn-icon">📝</span>
                    <span className="welcome-btn-text"><strong>New File</strong><small>Create a new file in the current folder</small></span>
                  </button>
                </div>
                {recentPaths && recentPaths.length > 0 && onOpenRecent && (
                  <div className="welcome-recent">
                    <div className="welcome-recent-title">Recent</div>
                    {recentPaths.map((p) => (
                      <button key={p} className="welcome-btn welcome-recent-btn" onClick={() => handleWelcomeClick(() => onOpenRecent(p))}>
                        <span className="welcome-btn-icon">📁</span>
                        <span className="welcome-btn-text">
                          <strong>{p.split(/[/\\]/).pop() || p}</strong>
                          <small>{p}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
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
                  ref={browserViewRef}
                  tabs={browserTabs}
                  activeTabId={activeBrowserTab?.id || ""}
                  onSelectTab={onActiveBrowserTabChange}
                  onCloseTab={handleBrowserTabCloseInner}
                  onAddTab={onAddBrowserTab}
                  onTitleChange={onBrowserTabUpdateLabel}
                  onUrlChange={onBrowserTabUpdateUrl}
                  onNewTab={onBrowserNewTabFromLink}
                  onConsoleEntry={handleBrowserConsoleEntry}
                  onOpenDevtools={onOpenDevtools}
                />
              </div>
            )}
            {files.map((f) => {
              const isActive = f.id === activeFileId;
              const previewable = previewKindOf(f);
              const mode = previewModeByFile[f.id] || "editor";
              const showEditor = !previewable || mode !== "preview";
              const showPreview = !!previewable && mode !== "editor";
              return (
              <div key={f.id} style={{ display: isActive ? "flex" : "none", height: "100%" }}>
                {showEditor && (
                  <div style={{ flex: 1, height: "100%", minWidth: 0 }}>
                <Editor
                  height="100%" language={f.language} theme="vs-dark"
                  value={f.content} onChange={(val) => updateFile(f.id, val || "")}
                  beforeMount={(monaco) => {
                    // Enable TypeScript diagnostics with lax settings for editing
                    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
                      target: monaco.languages.typescript.ScriptTarget.ESNext,
                      module: monaco.languages.typescript.ModuleKind.ESNext,
                      allowJs: true,
                      checkJs: true,
                      jsx: monaco.languages.typescript.JsxEmit.React,
                      strict: false,
                      noImplicitAny: false,
                      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
                      allowNonTsExtensions: true,
                      allowSyntheticDefaultImports: true,
                    });
                    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
                      noSemanticValidation: false,
                      noSyntaxValidation: false,
                    });
                    // JS side — keep syntax checking but DISABLE semantic (type)
                    // validation. Plain browser JS has no type info / module graph,
                    // so semantic checks produce many false positives
                    // ("Cannot find name 'require'", "Property X does not exist", …).
                    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
                      target: monaco.languages.typescript.ScriptTarget.ESNext,
                      module: monaco.languages.typescript.ModuleKind.ESNext,
                      allowJs: true,
                      checkJs: false,
                      jsx: monaco.languages.typescript.JsxEmit.React,
                      strict: false,
                      noImplicitAny: false,
                      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
                      allowNonTsExtensions: true,
                      allowSyntheticDefaultImports: true,
                    });
                    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
                      noSemanticValidation: true,
                      noSyntaxValidation: false,
                    });
                  }}
                  onMount={(editor) => {
                    const ed = editor as EditorViewHandle;
                    editorByFileIdRef.current[f.id] = ed;
                    // Breadcrumb follows the top visible line as the user scrolls.
                    const syncCrumb = () => {
                      try {
                        const ranges = ed.getVisibleRanges?.();
                        const top = ranges && ranges.length ? ranges[0].startLineNumber : undefined;
                        if (!top) return;
                        setCrumbLineByFile((prev) => (prev[f.id] === top ? prev : { ...prev, [f.id]: top }));
                      } catch { /* editor disposed */ }
                    };
                    ed.onDidScrollChange?.(syncCrumb);
                    ed.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
                      syncCrumb();
                      if (activeFileIdRef.current === f.id) {
                        setCursorPos({ line: e.position.lineNumber, column: e.position.column });
                      }
                    });

                    // Apply decorations immediately with whatever is available
                    applyDecorations(ed, f.id, gitDiffs[f.id], markersByFileId[f.id]);
                    applyAgentDiffDecorations(ed, f.id, agentDiffsRef.current[f.id]);
                    syncProblemMarkersForFile(f.id, ed);

                    // Click a glyph (git change or error/warning) to open the inline popup.
                    (editor as any).onMouseDown?.((e: any) => {
                      const mt = (window as any).monaco?.editor?.MouseTargetType;
                      const t = e.target?.type;
                      const isGutter = mt
                        ? (t === mt.GUTTER_GLYPH_MARGIN || t === mt.GUTTER_LINE_DECORATIONS)
                        : (t === 2 || t === 4);
                      if (isGutter && e.target?.position) {
                        togglePeek(editor, f.id, e.target.position.lineNumber);
                      }
                    });

                    // Register LSP-backed completion provider for languages Monaco
                    // doesn't handle natively (same set we run diagnostics for).
                    const lang = f.language;
                    if (!LSP_SKIP_LANGS.has(lang) && !lspRegistered.has(lang)) {
                      const monaco = (window as any).monaco;
                      if (monaco) {
                        lspRegistered.add(lang);
                        monaco.languages.registerCompletionItemProvider(lang, {
                          triggerCharacters: ["."],
                          provideCompletionItems: async (model: any, position: any) => {
                            const textUntil = model.getValueInRange({
                              startLineNumber: position.lineNumber,
                              startColumn: 1,
                              endLineNumber: position.lineNumber,
                              endColumn: position.column,
                            });
                            // Only trigger after . or at least 2 chars
                            if (!textUntil.endsWith(".") && textUntil.trim().length < 2) return { suggestions: [] };

                            try {
                              const res = await fetch("/api/lsp/complete", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  rootPath: fsBasePath,
                                  language: lang,
                                  filePath: f._fsPath || "",
                                  line: position.lineNumber,
                                  column: position.column,
                                }),
                              });
                              const data = await res.json();
                              if (data.ok && data.items) {
                                return {
                                  suggestions: data.items.map((item: any) => ({
                                    label: item.label,
                                    kind: mapLspKind(item.kind),
                                    detail: item.detail,
                                    documentation: item.documentation,
                                    insertText: item.insertText || item.label,
                                    sortText: item.sortText || item.label,
                                    range: {
                                      startLineNumber: position.lineNumber,
                                      startColumn: position.column - (textUntil.match(/\w*$/) || [""])[0].length,
                                      endLineNumber: position.lineNumber,
                                      endColumn: position.column,
                                    },
                                  })),
                                };
                              }
                            } catch { /* LSP server not available — fall through to default */ }
                            return { suggestions: [] };
                          },
                        });
                      }
                    }
                  }}
                  onValidate={(markers) => updateProblemMarkers(f.id, markers)}
                  options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, lineNumbers: "on", renderWhitespace: "selection", glyphMargin: true, overviewRulerLanes: 3, hideCursorInOverviewRuler: true, overviewRulerBorder: false, scrollbar: { vertical: "visible", verticalScrollbarSize: 14, alwaysConsumeMouseWheel: false } }}
                />
                  </div>
                )}
                {showPreview && (
                  <div style={{ flex: 1, height: "100%", minWidth: 0, borderLeft: mode === "split" ? "1px solid var(--border)" : "none" }}>
                    <FilePreview file={f} />
                  </div>
                )}
              </div>
              );
            })}
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
                agentTerminalBridge={agentTerminalBridge}
              />
            </div>
          </>
        )}
      </div>
      <NameDialog
        open={!!nameDialog}
        title={nameDialog?.title || ""}
        defaultValue={nameDialog?.defaultValue}
        defaultExt={nameDialog?.defaultExt || ""}
        extraValue={nameDialog?.extraValue || ""}
        type={nameDialog?.type}
        existingNames={nameDialog?.existingNames}
        onOk={(value, extra) => { nameDialog?.onOk(value, extra); }}
        onCancel={() => setNameDialog(null)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
    </>
  );
});

export default EditorPane;
