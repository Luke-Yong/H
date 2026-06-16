import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useResizable } from "../hooks/useResizable";

const WS_URL =
  window.location.port === "5173"
    ? "ws://localhost:3001/ws"
    : `ws://${window.location.host}/ws`;

function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("/")) return true;
  return false;
}

interface TermInstance {
  id: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  backend: "pty" | "pipe";
  input: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  historyKey: string;
  commandRunning: boolean;
  commandSawError: boolean;
  currentPromptMarker?: IMarker;
  lastCommandMarker?: IMarker;
  promptMarkers: Array<{ id: number; marker: IMarker; kind: "idle" | "success" | "error" }>;
  commandMarkerIds: number[];
  commandNavIndex: number;
  writeChain: Promise<void>;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  cwd?: string;
  venvDir?: string;
  activateScript?: string;
  onDetectUrl?: (sessionId: string, url: string) => void;
  debugEntries?: DebugConsoleEntry[];
  onClearDebugEntries?: () => void;
  outputEntries?: OutputEntry[];
  onClearOutputEntries?: () => void;
  problemEntries?: ProblemEntry[];
  onSelectProblem?: (problem: ProblemEntry) => void;
}

type Category = "problems" | "output" | "debugConsole" | "terminal";
type DebugSource = DebugConsoleEntry["source"];
type DebugLevel = DebugConsoleEntry["level"];
type OutputKind = OutputEntry["kind"];
type ProblemSeverity = ProblemEntry["severity"];

const DEBUG_SOURCES: DebugSource[] = ["app", "runtime", "server"];
const DEBUG_LEVELS: DebugLevel[] = ["log", "info", "warn", "error"];
const OUTPUT_KINDS: OutputKind[] = ["log", "action", "dom", "result", "error", "assistant", "code", "screenshot"];
const PROBLEM_SEVERITIES: ProblemSeverity[] = ["error", "warning", "info", "hint"];

export interface DebugConsoleEntry {
  id: string;
  level: "log" | "info" | "warn" | "error";
  source: "app" | "runtime" | "server";
  text: string;
  time: number;
}

export interface OutputEntry {
  id: string;
  kind: "log" | "action" | "dom" | "result" | "error" | "assistant" | "code" | "screenshot";
  text: string;
  time: number;
}

export interface ProblemEntry {
  id: string;
  fileId: string;
  fileName: string;
  filePath?: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string;
}

function getDefaultShellLabel(): string {
  const platform = (navigator.platform || "").toLowerCase();
  if (platform.includes("win")) return "powershell";
  return "bash";
}

function getCommandLabel(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0] || "";
}

function PromptIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="terminal-icon terminal-icon-prompt">
      <path d="M3 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 12h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="terminal-icon">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function TreeConnector({ shape }: { shape: "none" | "top" | "middle" | "bottom" }) {
  if (shape === "none") return null;
  const d =
    shape === "top"
      ? "M8 14V6.5a2 2 0 0 1 2-2H13"       // ┌  from bottom up, arm → right
      : shape === "bottom"
        ? "M8 2v7.5a2 2 0 0 0 2 2H13"       // └  from top down, arm → right
        : "M13 8H8M8 2v12";                   // ├  arm → right + vertical through
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="terminal-icon terminal-icon-connector">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="terminal-icon">
      <path d="M5 5.5v5M8 5.5v5M11 5.5v5M3.5 4.5h9M6 2.8h4l.5 1.7h-5zM4.5 4.5l.5 8h6l.5-8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function TerminalPane({
  visible,
  onClose,
  cwd,
  venvDir,
  activateScript,
  onDetectUrl,
  debugEntries = [],
  onClearDebugEntries,
  outputEntries = [],
  onClearOutputEntries,
  problemEntries = [],
  onSelectProblem,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const termsRef = useRef<Map<string, TermInstance>>(new Map());
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map()); // buffer output before xterm is ready
  const [gutterVersion, setGutterVersion] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const onDetectUrlRef = useRef(onDetectUrl);
  const groupKeyRef = useRef("");
  const openedOnceRef = useRef(false);
  const [termIds, setTermIds] = useState<string[]>([]);
  const termIdsRef = useRef<string[]>([]);
  const [backendById, setBackendById] = useState<Record<string, "pty" | "pipe">>({});
  const [labelById, setLabelById] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string>("");
  const activeIdRef = useRef(activeId);
  // 2-level nested: [[A], [B, B2, B3], [C]] — "+" adds a group, split adds to a group
  const [terminalGroups, setTerminalGroups] = useState<string[][]>([]);
  const terminalGroupsRef = useRef<string[][]>([]);
  const [activeGroupIndex, setActiveGroupIndex] = useState(0);
  const activeGroupIndexRef = useRef(0);
  const pendingCreateForGroupRef = useRef(-1); // -1 = new group, >=0 = append to group
  const cwdRef = useRef<string>("");
  const venvRef = useRef<string>("");
  const activateRef = useRef<string>("");
  const hasRealCwdRef = useRef<boolean>(false);
  const [activeCategory, setActiveCategory] = useState<Category>("terminal");
  const [debugSourceFilters, setDebugSourceFilters] = useState<Record<DebugSource, boolean>>({
    app: true,
    runtime: true,
    server: true,
  });
  const [debugLevelFilters, setDebugLevelFilters] = useState<Record<DebugLevel, boolean>>({
    log: true,
    info: true,
    warn: true,
    error: true,
  });
  const [outputKindFilters, setOutputKindFilters] = useState<Record<OutputKind, boolean>>({
    log: true,
    action: true,
    dom: false,
    result: true,
    error: true,
    assistant: true,
    code: true,
    screenshot: false,
  });
  const { size: sidebarWidth, onMouseDown: onSidebarResize } = useResizable(164, 44, 280, true);
  const sidebarCollapsed = sidebarWidth <= 72;

  const envTooltip = [
    cwd ? `cwd: ${cwd}` : "",
    venvDir ? `venv: ${venvDir}` : "",
    activateScript ? `activate: ${activateScript}` : "",
  ].filter(Boolean).join("\n") || "No environment configured";
  const defaultShellLabel = useMemo(() => getDefaultShellLabel(), []);
  const filteredDebugEntries = useMemo(
    () => debugEntries.filter((entry) => debugSourceFilters[entry.source] && debugLevelFilters[entry.level]),
    [debugEntries, debugLevelFilters, debugSourceFilters]
  );
  const filteredOutputEntries = useMemo(
    () => outputEntries.filter((entry) => outputKindFilters[entry.kind]),
    [outputEntries, outputKindFilters]
  );
  const sortedProblemEntries = useMemo(() => {
    const severityOrder: Record<ProblemSeverity, number> = {
      error: 0,
      warning: 1,
      info: 2,
      hint: 3,
    };
    return [...problemEntries].sort((a, b) => {
      const bySeverity = severityOrder[a.severity] - severityOrder[b.severity];
      if (bySeverity !== 0) return bySeverity;
      const byFile = a.fileName.localeCompare(b.fileName);
      if (byFile !== 0) return byFile;
      const byLine = a.line - b.line;
      if (byLine !== 0) return byLine;
      return a.column - b.column;
    });
  }, [problemEntries]);
  const problemCounts = useMemo(() => {
    const counts: Record<ProblemSeverity, number> = {
      error: 0,
      warning: 0,
      info: 0,
      hint: 0,
    };
    for (const entry of problemEntries) counts[entry.severity] += 1;
    return counts;
  }, [problemEntries]);
  // Current active group's members displayed in the grid
  const activeGroupMembers = terminalGroups[activeGroupIndex] || [];

  const getNextSelectionAfterRemoval = useCallback((removedId: string) => {
    const groups = terminalGroupsRef.current
      .map((g) => g.filter((x) => x !== removedId))
      .filter((g) => g.length > 0);
    const allLeft = termIdsRef.current.filter((x) => x !== removedId);
    if (groups.length === 0) {
      return { groups, nextGroupIndex: 0, nextActiveId: allLeft[0] || "" };
    }

    const currentGroup = terminalGroupsRef.current[activeGroupIndexRef.current] || [];
    const removedFromActiveGroup = currentGroup.includes(removedId);
    let nextGroupIndex = activeGroupIndexRef.current;

    if (removedFromActiveGroup) {
      nextGroupIndex = Math.min(activeGroupIndexRef.current, groups.length - 1);
    } else {
      const removedGroupIndex = terminalGroupsRef.current.findIndex((g) => g.includes(removedId));
      if (removedGroupIndex >= 0 && removedGroupIndex < activeGroupIndexRef.current) {
        nextGroupIndex = Math.max(0, activeGroupIndexRef.current - 1);
      } else {
        nextGroupIndex = Math.min(activeGroupIndexRef.current, groups.length - 1);
      }
    }

    const nextGroup = groups[nextGroupIndex] || [];
    const nextActiveId = removedFromActiveGroup
      ? (nextGroup[0] || allLeft[0] || "")
      : (nextGroup.includes(activeIdRef.current) ? activeIdRef.current : (nextGroup[0] || allLeft[0] || ""));

    return { groups, nextGroupIndex, nextActiveId };
  }, []);

  const toggleDebugSourceFilter = useCallback((source: DebugSource) => {
    setDebugSourceFilters((prev) => ({ ...prev, [source]: !prev[source] }));
  }, []);

  const toggleDebugLevelFilter = useCallback((level: DebugLevel) => {
    setDebugLevelFilters((prev) => ({ ...prev, [level]: !prev[level] }));
  }, []);

  const resetDebugFilters = useCallback(() => {
    setDebugSourceFilters({ app: true, runtime: true, server: true });
    setDebugLevelFilters({ log: true, info: true, warn: true, error: true });
  }, []);

  const toggleOutputKindFilter = useCallback((kind: OutputKind) => {
    setOutputKindFilters((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  const resetOutputFilters = useCallback(() => {
    setOutputKindFilters({
      log: true,
      action: true,
      dom: false,
      result: true,
      error: true,
      assistant: true,
      code: true,
      screenshot: false,
    });
  }, []);

  // Keep ref in sync for the WS effect (which must NOT re-run on activeId changes)
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { termIdsRef.current = termIds; }, [termIds]);
  useEffect(() => { terminalGroupsRef.current = terminalGroups; }, [terminalGroups]);
  useEffect(() => { activeGroupIndexRef.current = activeGroupIndex; }, [activeGroupIndex]);
  useEffect(() => { onDetectUrlRef.current = onDetectUrl; }, [onDetectUrl]);
  useEffect(() => {
    const c = (cwd || "").trim();
    cwdRef.current = c;
    hasRealCwdRef.current = isAbsolutePath(c);
  }, [cwd]);
  useEffect(() => { venvRef.current = (venvDir || "").trim(); }, [venvDir]);
  useEffect(() => { activateRef.current = (activateScript || "").trim(); }, [activateScript]);

  const sendToServer = useCallback((id: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(`term:write:${id}:${data}`);
    }
  }, []);

  const getHistoryKey = useCallback(() => {
    const c = (cwdRef.current || "").trim();
    return `harness.term.history:${c || "default"}`;
  }, []);

  const loadHistory = useCallback((key: string): string[] => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
      return [];
    } catch {
      return [];
    }
  }, []);

  const saveHistory = useCallback((key: string, items: string[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(items.slice(-200)));
    } catch {}
  }, []);

  const setInputLine = useCallback((inst: TermInstance, next: string) => {
    const prev = inst.input;
    const toEnd = prev.length - inst.cursor;
    if (toEnd > 0) inst.term.write(`\x1b[${toEnd}C`);
    if (prev.length) inst.term.write("\b \b".repeat(prev.length));
    inst.input = next;
    inst.cursor = next.length;
    if (next.length) inst.term.write(next);
  }, []);

  const bumpGutter = useCallback(() => {
    setGutterVersion((v) => v + 1);
  }, []);

  const ensurePromptMarker = useCallback((inst: TermInstance) => {
    const existing = inst.currentPromptMarker;
    if (existing && existing.line >= 0) return existing;
    const marker = inst.term.registerMarker(0);
    if (!marker) return undefined;
    inst.currentPromptMarker = marker;
    inst.promptMarkers = [...inst.promptMarkers, { id: marker.id, marker, kind: "idle" }];
    bumpGutter();
    return marker;
  }, [bumpGutter]);

  const runLine = useCallback((inst: TermInstance) => {
    const line = inst.input;
    ensurePromptMarker(inst);
    if (line.trim().length) {
      if (inst.history[inst.history.length - 1] !== line) inst.history.push(line);
      saveHistory(inst.historyKey, inst.history);
    }
    inst.historyIndex = inst.history.length;
    inst.input = "";
    inst.cursor = 0;
    inst.term.write("\r\n");
    sendToServer(inst.id, `${line}\r\n`);
    if (inst.backend === "pipe") {
      inst.commandRunning = true;
      inst.commandSawError = false;
      inst.lastCommandMarker = inst.currentPromptMarker;
      const m = inst.lastCommandMarker;
      if (m && (inst.commandMarkerIds.length === 0 || inst.commandMarkerIds[inst.commandMarkerIds.length - 1] !== m.id)) {
        inst.commandMarkerIds = [...inst.commandMarkerIds, m.id];
      }
      inst.commandNavIndex = inst.commandMarkerIds.length;
      const label = getCommandLabel(line);
      if (label) setLabelById((prev) => ({ ...prev, [inst.id]: label }));
    }
  }, [ensurePromptMarker, saveHistory, sendToServer]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && moreRef.current?.contains(t)) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const setCommandDecorationKind = useCallback((inst: TermInstance, marker: IMarker | undefined, kind: "idle" | "success" | "error") => {
    if (!marker) return;
    inst.promptMarkers = inst.promptMarkers.map((entry) => (
      entry.marker.id === marker.id ? { ...entry, kind } : entry
    ));
    bumpGutter();
  }, [bumpGutter]);

  const createPromptDecoration = useCallback((inst: TermInstance) => {
    const marker = inst.term.registerMarker(0);
    if (!marker) return;
    inst.currentPromptMarker = marker;
    inst.promptMarkers = [...inst.promptMarkers, { id: marker.id, marker, kind: "idle" }];
    bumpGutter();
  }, [bumpGutter]);

  const termWrite = useCallback((term: Terminal, data: string) => {
    return new Promise<void>((resolve) => term.write(data, resolve));
  }, []);

  const writeWithPromptHandling = useCallback((inst: TermInstance, chunk: string) => {
    inst.writeChain = inst.writeChain.then(async () => {
      const promptRe = /(^|\r?\n|\r)((?:\x1b\[[0-9;?]*[ -/]*[@-~])*)(?:\([^)\r\n]*\)\s*)?(PS [^\r\n]*?> ?)/g;
      let last = 0;
      let match: RegExpExecArray | null;
      let matchCount = 0;
      while ((match = promptRe.exec(chunk))) {
        matchCount += 1;
        const start = match.index;
        const full = match[0];
        const prefix = match[1] || "";
        const ansi = match[2] || "";
        const prompt = match[3] || "";
        const before = chunk.slice(last, start);
        if (before) await termWrite(inst.term, before);
        await termWrite(inst.term, `${prefix}${ansi}${prompt}`);
        if (inst.commandRunning) {
          setCommandDecorationKind(inst, inst.lastCommandMarker, inst.commandSawError ? "error" : "success");
          inst.commandRunning = false;
          inst.commandSawError = false;
          inst.lastCommandMarker = undefined;
        }
        createPromptDecoration(inst);
        last = start + full.length;
      }
      const tail = chunk.slice(last);
      if (tail) await termWrite(inst.term, tail);
    }).catch(() => {});
  }, [createPromptDecoration, setCommandDecorationKind, termWrite]);

  const insertAtCursor = useCallback((inst: TermInstance, text: string) => {
    if (!text) return;
    const before = inst.input.slice(0, inst.cursor);
    const after = inst.input.slice(inst.cursor);
    inst.input = before + text + after;
    inst.cursor += text.length;
    if (after.length) {
      inst.term.write(text + after + `\x1b[${after.length}D`);
    } else {
      inst.term.write(text);
    }
  }, []);

  const handlePasteText = useCallback((inst: TermInstance, text: string) => {
    if (inst.backend === "pty") {
      sendToServer(inst.id, text);
      return;
    }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part) insertAtCursor(inst, part);
      if (i < parts.length - 1) {
        runLine(inst);
      }
    }
  }, [insertAtCursor, runLine, sendToServer]);

  const handleInput = useCallback((inst: TermInstance, data: string) => {
    if (inst.backend === "pty") {
      if (data === "\r") {
        ensurePromptMarker(inst);
        inst.commandRunning = true;
        inst.commandSawError = false;
        inst.lastCommandMarker = inst.currentPromptMarker;
        const m = inst.lastCommandMarker;
        if (m && (inst.commandMarkerIds.length === 0 || inst.commandMarkerIds[inst.commandMarkerIds.length - 1] !== m.id)) {
          inst.commandMarkerIds = [...inst.commandMarkerIds, m.id];
        }
        inst.commandNavIndex = inst.commandMarkerIds.length;
      }
      sendToServer(inst.id, data);
      return;
    }
    if (data === "\x1b[A") {
      if (!inst.history.length) return;
      const nextIdx = Math.max(0, inst.historyIndex - 1);
      inst.historyIndex = nextIdx;
      setInputLine(inst, inst.history[nextIdx] || "");
      return;
    }

    if (data === "\x1b[B") {
      if (!inst.history.length) return;
      const nextIdx = Math.min(inst.history.length, inst.historyIndex + 1);
      inst.historyIndex = nextIdx;
      setInputLine(inst, inst.history[nextIdx] || "");
      return;
    }

    if (data.length > 1 && (data.includes("\n") || data.includes("\r"))) {
      handlePasteText(inst, data);
      return;
    }

    if (data === "\r") {
      runLine(inst);
      return;
    }

    if (data === "\x03") {
      inst.term.write("^C\r\n");
      inst.input = "";
      inst.cursor = 0;
      inst.historyIndex = inst.history.length;
      sendToServer(inst.id, "\x03");
      return;
    }

    if (data === "\x7f" || data === "\x08") {
      if (inst.cursor <= 0) return;
      const before = inst.input.slice(0, inst.cursor - 1);
      const after = inst.input.slice(inst.cursor);
      inst.input = before + after;
      inst.cursor -= 1;
      inst.term.write("\x1b[D" + after + " " + `\x1b[${after.length + 1}D`);
      return;
    }

    if (data === "\x1b[D") {
      if (inst.cursor <= 0) return;
      inst.cursor -= 1;
      inst.term.write("\x1b[D");
      return;
    }

    if (data === "\x1b[C") {
      if (inst.cursor >= inst.input.length) return;
      inst.cursor += 1;
      inst.term.write("\x1b[C");
      return;
    }

    if (data === "\x1b[H" || data === "\x1b[1~") {
      if (inst.cursor <= 0) return;
      inst.term.write(`\x1b[${inst.cursor}D`);
      inst.cursor = 0;
      return;
    }

    if (data === "\x1b[F" || data === "\x1b[4~") {
      const delta = inst.input.length - inst.cursor;
      if (delta <= 0) return;
      inst.term.write(`\x1b[${delta}C`);
      inst.cursor = inst.input.length;
      return;
    }

    if (data === "\x1b[3~") {
      if (inst.cursor >= inst.input.length) return;
      const before = inst.input.slice(0, inst.cursor);
      const after = inst.input.slice(inst.cursor + 1);
      inst.input = before + after;
      inst.term.write(after + " " + `\x1b[${after.length + 1}D`);
      return;
    }

    if (data.startsWith("\x1b")) return;

    insertAtCursor(inst, data);
  }, [ensurePromptMarker, handlePasteText, insertAtCursor, runLine, sendToServer, setInputLine]);

  const createTerminal = useCallback((id: string, container: HTMLDivElement, backend: "pty" | "pipe") => {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#264f78",
        black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
        blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
        brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
        brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
        brightCyan: "#29b8db", brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      windowsMode: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const inst: TermInstance = {
      id,
      term,
      fit,
      container,
      backend,
      input: "",
      cursor: 0,
      history: [],
      historyIndex: 0,
      historyKey: "",
      commandRunning: false,
      commandSawError: false,
      promptMarkers: [],
      commandMarkerIds: [],
      commandNavIndex: -1,
      writeChain: Promise.resolve(),
    };

    inst.historyKey = getHistoryKey();
    if (backend === "pipe") {
      inst.history = loadHistory(inst.historyKey);
      inst.historyIndex = inst.history.length;
    }

    // Show diagnostic header
    const isDesktop = !!(window as any).harnessDesktop?.isDesktop;
    if (hasRealCwdRef.current) {
      term.writeln(`\r\n\x1b[36m[Harness]\x1b[0m cwd=\x1b[33m${cwdRef.current}\x1b[0m  (\x1b[32mElectron\x1b[0m)\r\n`);
    } else {
      term.writeln("\r\n\x1b[36m[Harness]\x1b[0m \x1b[31mNo project folder detected\x1b[0m");
      if (isDesktop) {
        term.writeln("[Harness] You are in Electron but no folder path was provided.");
      } else {
        term.writeln("[Harness] You are in a \x1b[33mbrowser\x1b[0m — the file picker can't give real paths.");
        term.writeln("[Harness] Run \x1b[33mnpm run desktop:dev\x1b[0m for real project-following terminals.\r\n");
      }
    }

    term.attachCustomKeyEventHandler((ev) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const ctrlOrMeta = isMac ? ev.metaKey : ev.ctrlKey;

      if (ev.type === "keydown" && ctrlOrMeta && !ev.shiftKey && ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      }

      if (ev.type === "keydown" && ctrlOrMeta && ev.shiftKey && ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.type === "keydown" && ctrlOrMeta && (ev.code === "KeyV" || (ev.shiftKey && ev.code === "KeyV"))) {
        void navigator.clipboard.readText().then((t) => handlePasteText(inst, t)).catch(() => {});
        return false;
      }
      if (ev.type === "keydown" && ev.shiftKey && ev.code === "Insert") {
        void navigator.clipboard.readText().then((t) => handlePasteText(inst, t)).catch(() => {});
        return false;
      }
      if (ev.type === "keydown" && ctrlOrMeta && ev.code === "Insert") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }

      return true;
    });

    term.onData((data) => handleInput(inst, data));
    term.onScroll(() => bumpGutter());
    const viewportEl = term.element?.querySelector(".xterm-viewport");
    const handleViewportScroll = () => bumpGutter();
    viewportEl?.addEventListener("scroll", handleViewportScroll);

    term.onResize(({ cols, rows }) => {
      fit.fit();
      bumpGutter();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(`term:resize:${id}:${cols}:${rows}`);
      }
    });

    // Flush any output buffered before the xterm was ready
    const buffered = pendingOutputRef.current.get(id);
    if (buffered) {
      pendingOutputRef.current.delete(id);
      for (const chunk of buffered) {
        if (inst.commandRunning && /error|exception|failed|not recognized|cannot|categoryinfo|fullyqualifiederrorid|itemnotfoundexception/i.test(chunk)) {
          inst.commandSawError = true;
        }
        writeWithPromptHandling(inst, chunk);
      }
    }

    termsRef.current.set(id, inst);
  }, [bumpGutter, getHistoryKey, handleInput, handlePasteText, loadHistory, writeWithPromptHandling]);

  // Auto-close pane when all terminals are gone (and WS was established)
  useEffect(() => {
    if (!visible) return;
    if (termIds.length > 0) return;
    if (!groupKeyRef.current) return;
    if (!openedOnceRef.current) return;
    const timer = setTimeout(() => {
      onClose();
    }, 200);
    return () => clearTimeout(timer);
  }, [visible, termIds.length, onClose]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    const groupKey = `term-${Date.now()}`;
    groupKeyRef.current = groupKey;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);

    ws.onmessage = (msg) => {
      const data = msg.data as string;
      if (data.startsWith("term:ready:")) {
        const rest = data.slice(11);
        const sep = rest.indexOf(":");
        const id = sep === -1 ? rest : rest.slice(0, sep);
        const backend = (sep === -1 ? "pipe" : rest.slice(sep + 1)) === "pty" ? "pty" : "pipe";
        const forGroupIdx = pendingCreateForGroupRef.current;
        pendingCreateForGroupRef.current = -1;
        openedOnceRef.current = true;
        setBackendById((prev) => ({ ...prev, [id]: backend }));
        setLabelById((prev) => ({ ...prev, [id]: defaultShellLabel }));
        setTermIds((prev) => [...prev, id]);
        if (forGroupIdx >= 0 && terminalGroupsRef.current[forGroupIdx]) {
          setTerminalGroups((prev) => {
            const next = prev.map((g) => [...g]);
            next[forGroupIdx] = [...next[forGroupIdx], id];
            return next;
          });
          setActiveGroupIndex(forGroupIdx);
        } else {
          setTerminalGroups((prev) => [...prev, [id]]);
          setActiveGroupIndex(terminalGroupsRef.current.length);
        }
        setActiveId(id);
      } else if (data.startsWith("term:out:")) {
        const rest = data.slice(9);
        const idx = rest.indexOf(":");
        if (idx === -1) return;
        const id = rest.slice(0, idx);
        const output = rest.slice(idx + 1);
        const clean = output
          .replace(/\x7f/g, "\x08")
          .replace(/(?<!\x1b)\[(?=[0-9?;]+[A-Za-z@])/g, "\x1b[");
        const inst = termsRef.current.get(id);
        if (inst) {
          if (inst.commandRunning && /error|exception|failed|not recognized|cannot|categoryinfo|fullyqualifiederrorid|itemnotfoundexception/i.test(clean)) {
            inst.commandSawError = true;
          }
          writeWithPromptHandling(inst, clean);
          return;
        } else {
          // Terminal not yet created — buffer output
          const buf = pendingOutputRef.current.get(id) || [];
          buf.push(clean);
          pendingOutputRef.current.set(id, buf);
        }
      } else if (data.startsWith("term:url:")) {
        // term:url:sessionId:url
        const rest = data.slice(9);
        const idx = rest.indexOf(":");
        if (idx === -1) return;
        const id = rest.slice(0, idx);
        const url = rest.slice(idx + 1);
        onDetectUrlRef.current?.(id, url);
      } else if (data.startsWith("term:exit:")) {
        const rest = data.slice(10);
        const idx = rest.indexOf(":");
        if (idx === -1) return;
        const id = rest.slice(0, idx);
        const code = rest.slice(idx + 1);
        const inst = termsRef.current.get(id);
        inst?.term.writeln(`\r\n[Process exited code=${code}]`);
        setTermIds((prev) => prev.filter((x) => x !== id));
        const nextSelection = getNextSelectionAfterRemoval(id);
        setTerminalGroups(nextSelection.groups);
        setActiveGroupIndex(nextSelection.nextGroupIndex);
        setActiveId(nextSelection.nextActiveId);
        setLabelById((labels) => {
          const { [id]: _, ...rest } = labels;
          return rest;
        });
      }
    };

    return () => {
      pendingOutputRef.current.clear();
      ws.close();
    };
  }, []);

  // Attach terminals when their DOM container becomes available
  useEffect(() => {
    if (!visible) return;
    if (activeCategory !== "terminal") return;
    let raf: number;
    raf = requestAnimationFrame(() => {
      for (const id of activeGroupMembers) {
        const el = document.getElementById(`term-host-${id}`);
        if (!el) continue;
        const existing = termsRef.current.get(id);
        if (existing) {
          if (existing.container !== el) {
            while (el.firstChild) el.removeChild(el.firstChild);
            const termEl = existing.term.element;
            if (termEl) {
              el.appendChild(termEl);
            } else {
              existing.term.open(el as HTMLDivElement);
            }
            existing.container = el as HTMLDivElement;
          }
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try { existing.fit.fit(); } catch {}
            });
          });
          continue;
        }
        createTerminal(id, el as HTMLDivElement, backendById[id] || "pipe");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const inst = termsRef.current.get(id);
            try { inst?.fit.fit(); } catch {}
          });
        });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [activeCategory, backendById, visible, createTerminal, activeGroupMembers, activeId]);

  useEffect(() => {
    for (const [id] of termsRef.current) {
      if (!termIds.includes(id)) {
        const inst = termsRef.current.get(id);
        try { inst?.term.dispose(); } catch {}
        termsRef.current.delete(id);
        pendingOutputRef.current.delete(id);
      }
    }
  }, [termIds]);

  // Re-fit on panel resize
  useEffect(() => {
    if (!visible) return;
    const handler = () => {
      for (const [, inst] of termsRef.current) {
        try { inst.fit.fit(); } catch {}
      }
      bumpGutter();
    };
    const obs = new ResizeObserver(handler);
    if (panelRef.current) obs.observe(panelRef.current);
    return () => obs.disconnect();
  }, [bumpGutter, visible]);

  const requestTerminal = useCallback((groupIndex: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      pendingCreateForGroupRef.current = groupIndex;
      const c = hasRealCwdRef.current ? cwdRef.current : "";
      const v = venvRef.current;
      const a = activateRef.current;
      wsRef.current.send(`term:create:${groupKeyRef.current}:${encodeURIComponent(c)}:${encodeURIComponent(v)}:${encodeURIComponent(a)}`);
    }
  }, []);

  // "+" — new terminal group
  const addTerminal = useCallback(() => {
    requestTerminal(-1);
  }, [requestTerminal]);

  // Split — append to an existing group
  const createSplitTerminal = useCallback((id: string) => {
    // Find which group this terminal belongs to
    const gi = terminalGroupsRef.current.findIndex((g) => g.includes(id));
    requestTerminal(gi >= 0 ? gi : -1);
  }, [requestTerminal]);

  // Click a sidebar tab → switch to its group
  const selectTerminal = useCallback((id: string) => {
    const gi = terminalGroupsRef.current.findIndex((g) => g.includes(id));
    if (gi >= 0) {
      setActiveGroupIndex(gi);
    }
    setActiveId(id);
    setActiveCategory("terminal");
  }, []);

  const killTerminal = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(`term:kill:${id}`);
    }
    setTermIds((prev) => prev.filter((x) => x !== id));
    const nextSelection = getNextSelectionAfterRemoval(id);
    setTerminalGroups(nextSelection.groups);
    setActiveGroupIndex(nextSelection.nextGroupIndex);
    setActiveId(nextSelection.nextActiveId);
    setLabelById((labels) => {
      const { [id]: _, ...rest } = labels;
      return rest;
    });
    // Schedule close check after this state update commits
    const nextAll = termIdsRef.current.filter((x) => x !== id);
    if (nextAll.length === 0 && openedOnceRef.current) {
      setTimeout(() => onClose(), 0);
    }
  }, [getNextSelectionAfterRemoval, onClose]);

  // Auto-open one terminal when pane becomes visible
  useEffect(() => {
    if (!visible) return;
    if (termIds.length > 0) return;
    if (!wsConnected) return;
    requestTerminal(-1);
  }, [visible, termIds.length, requestTerminal, wsConnected]);

  useEffect(() => {
    if (!activeGroupMembers.length) return;
    // Double rAF ensures CSS flex layout has fully settled before fitting xterm dimensions
    let raf1: number;
    let raf2: number;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        for (const id of activeGroupMembers) {
          const inst = termsRef.current.get(id);
          try { inst?.fit.fit(); } catch {}
        }
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [activeGroupMembers]);

  if (!visible) return null;

  const categories: { key: Category; label: string }[] = [
    { key: "problems", label: "Problems" },
    { key: "output", label: "Output" },
    { key: "debugConsole", label: "Debug Console" },
    { key: "terminal", label: "Terminal" },
  ];

  const renderGutterMarkers = (id: string) => {
    void gutterVersion;
    const inst = termsRef.current.get(id);
    const screen = inst?.term.element?.querySelector(".xterm-screen") as HTMLDivElement | null;
    if (!inst || !screen || inst.term.rows <= 0) return null;
    const viewportY = inst.term.buffer.active.viewportY;
    const cellHeight = screen.clientHeight / inst.term.rows;
    return inst.promptMarkers
      .filter((entry) => entry.marker.line >= 0)
      .map((entry) => {
        const row = entry.marker.line - viewportY;
        if (row < 0 || row >= inst.term.rows) return null;
        return (
          <div
            key={`${id}-${entry.id}`}
            className={`terminal-gutter-marker terminal-gutter-marker-${entry.kind}`}
            style={{ top: `${Math.round(row * cellHeight)}px`, height: `${Math.ceil(cellHeight)}px` }}
            title="Show Command Actions"
          >
            <span className="term-command-action-dot" />
          </div>
        );
      });
  };

  const getCommandLines = useCallback((inst: TermInstance): number[] => {
    const lines: number[] = [];
    for (const mid of inst.commandMarkerIds) {
      const entry = inst.promptMarkers.find((e) => e.marker.id === mid);
      const line = entry?.marker.line ?? -1;
      if (line >= 0) lines.push(line);
    }
    lines.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (const ln of lines) {
      if (uniq.length === 0 || uniq[uniq.length - 1] !== ln) uniq.push(ln);
    }
    return uniq;
  }, []);

  const scrollToPrevCommand = useCallback(() => {
    const inst = termsRef.current.get(activeIdRef.current);
    if (!inst) return;
    const top = inst.term.buffer.active.viewportY;
    const bottom = top + Math.max(0, inst.term.rows - 1);
    const lines = getCommandLines(inst);
    if (!lines.length) return;
    const maxIdxInView = (() => {
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] <= bottom) idx = i;
        else break;
      }
      return idx;
    })();
    if (maxIdxInView < 0) return;

    let nextIdx = inst.commandNavIndex;
    if (nextIdx < 0 || nextIdx > maxIdxInView) nextIdx = maxIdxInView;
    else nextIdx = Math.max(0, nextIdx - 1);

    inst.commandNavIndex = nextIdx;
    inst.term.scrollToLine(lines[nextIdx]);
    bumpGutter();
  }, [bumpGutter, getCommandLines]);

  const scrollToNextCommand = useCallback(() => {
    const inst = termsRef.current.get(activeIdRef.current);
    if (!inst) return;
    const top = inst.term.buffer.active.viewportY;
    const bottom = top + Math.max(0, inst.term.rows - 1);
    const lines = getCommandLines(inst);
    if (!lines.length) return;
    const maxIdxInView = (() => {
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] <= bottom) idx = i;
        else break;
      }
      return idx;
    })();

    let nextIdx = inst.commandNavIndex;
    if (nextIdx < 0) nextIdx = maxIdxInView;
    if (nextIdx >= lines.length - 1) return;
    nextIdx = nextIdx + 1;

    inst.commandNavIndex = nextIdx;
    inst.term.scrollToLine(lines[nextIdx]);
    bumpGutter();
  }, [bumpGutter, getCommandLines]);

  return (
    <div className="terminal-pane">
      <div className="pane-header terminal-pane-header">
        <div className="terminal-category-tabs">
          {categories.map((cat) => (
            <button
              key={cat.key}
              className={`terminal-category-tab${activeCategory === cat.key ? " active" : ""}`}
              onClick={() => setActiveCategory(cat.key)}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <div className="terminal-header-actions">
          {activeCategory === "terminal" && (
            <>
              <div className="terminal-more" ref={moreRef}>
                <button
                  className="terminal-instance-btn terminal-header-btn"
                  onClick={() => setMoreOpen((v) => !v)}
                  title="More actions"
                >
                  ⋯
                </button>
                {moreOpen && (
                  <div className="terminal-more-menu" role="menu">
                    <button
                      className="terminal-more-item"
                      onClick={() => { scrollToPrevCommand(); setMoreOpen(false); }}
                    >
                      Scroll to previous command
                    </button>
                    <button
                      className="terminal-more-item"
                      onClick={() => { scrollToNextCommand(); setMoreOpen(false); }}
                    >
                      Scroll to next command
                    </button>
                  </div>
                )}
              </div>
              {sidebarCollapsed && activeId && (
                <button className="terminal-instance-btn terminal-header-btn" onClick={() => createSplitTerminal(activeId)} title="Split terminal">
                  <SplitIcon />
                </button>
              )}
              {sidebarCollapsed && activeId && (
                <button className="terminal-instance-btn terminal-header-btn" onClick={() => killTerminal(activeId)} title="Kill terminal">
                  <TrashIcon />
                </button>
              )}
            </>
          )}
          {activeCategory === "terminal" && (
            <button className="terminal-instance-btn terminal-header-btn" onClick={() => { setActiveCategory("terminal"); addTerminal(); }} title="New terminal">
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
            </button>
          )}
          <button className="terminal-close-btn" onClick={onClose} title="Close panel">✕</button>
        </div>
      </div>
      {activeCategory === "terminal" && (
        <div className="terminal-body">
          <div className="terminal-container" ref={panelRef}>
            <div className={`terminal-grid${activeGroupMembers.length > 1 ? " split" : ""}`}>
              {activeGroupMembers.length === 0 && (
                <div className="terminal-placeholder">No terminal selected</div>
              )}
              {activeGroupMembers.map((id) => (
                <div
                  key={id}
                  className={`terminal-slot active${id === activeId ? " focused" : ""}`}
                  style={{ display: "flex", flex: 1, minWidth: 0 }}
                  onClick={() => setActiveId(id)}
                >
                  <div className="terminal-slot-gutter" aria-hidden="true">
                    {renderGutterMarkers(id)}
                  </div>
                  <div id={`term-host-${id}`} className="terminal-screen-host" />
                </div>
              ))}
            </div>
          </div>
          <div className="resize-handle terminal-sidebar-resize" onMouseDown={onSidebarResize} />
          <div
            className={`terminal-instance-sidebar${sidebarCollapsed ? " collapsed" : ""}`}
            style={{ width: sidebarWidth }}
          >
            {terminalGroups.flatMap((group, gi) => {
              const isMulti = group.length > 1;
              return group.map((id, rank) => {
                let treeShape: "none" | "top" | "middle" | "bottom" = "none";
                let splitClass = "";
                if (isMulti) {
                  if (rank === 0) {
                    treeShape = "top";
                    splitClass = " split-paired-top";
                  } else if (rank === group.length - 1) {
                    treeShape = "bottom";
                    splitClass = " split-paired-bottom";
                  } else {
                    treeShape = "middle";
                    splitClass = " split-paired-middle";
                  }
                } else {
                  splitClass = " in-view";
                }
                return (
                <div
                  key={id}
                  className={`terminal-instance-tab${id === activeId ? " active" : ""}${splitClass}`}
                  title={envTooltip}
                  onClick={() => selectTerminal(id)}
                >
                  <span className="terminal-instance-main">
                    <TreeConnector shape={treeShape} />
                    <PromptIcon />
                    {!sidebarCollapsed && (
                      <span className="terminal-instance-label">
                        {labelById[id] || `${defaultShellLabel} ${rank + 1}`}
                      </span>
                    )}
                  </span>
                  {!sidebarCollapsed && (
                    <span className="terminal-instance-controls">
                      <button
                        className="terminal-instance-btn"
                        onClick={(e) => { e.stopPropagation(); createSplitTerminal(id); }}
                        title="Split terminal"
                      >
                        <SplitIcon />
                      </button>
                      <button
                        className="terminal-instance-btn"
                        onClick={(e) => { e.stopPropagation(); killTerminal(id); }}
                        title="Kill terminal"
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  )}
                </div>
                );
              });
            })}
          </div>
        </div>
      )}
      {activeCategory !== "terminal" && (
        <div className="terminal-placeholder terminal-debug-console">
          {activeCategory === "problems" && (
            <div className="debug-console-panel">
              <div className="debug-console-toolbar">
                <div className="debug-console-filter-group">
                  <span className="debug-console-filter-label">Problems</span>
                  {PROBLEM_SEVERITIES.map((severity) => (
                    <span key={severity} className={`debug-console-badge debug-console-badge-problem debug-console-badge-problem-${severity}`}>
                      {severity} {problemCounts[severity]}
                    </span>
                  ))}
                </div>
              </div>
              {sortedProblemEntries.length === 0 ? (
                <div className="debug-console-empty">No problems detected.</div>
              ) : (
                <div className="debug-console-list">
                  {sortedProblemEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`debug-console-entry debug-console-entry-${entry.severity === "warning" ? "warn" : entry.severity === "error" ? "error" : "info"} problem-entry`}
                      onClick={() => onSelectProblem?.(entry)}
                      title={`Open ${entry.fileName}:${entry.line}:${entry.column}`}
                    >
                      <span className="problem-entry-location" title={entry.filePath || entry.fileName}>
                        {entry.fileName}:{entry.line}:{entry.column}
                      </span>
                      <span className={`debug-console-badge debug-console-badge-problem debug-console-badge-problem-${entry.severity}`}>
                        {entry.severity}
                      </span>
                      <span className="debug-console-text">
                        {entry.message}
                        {(entry.source || entry.code) && (
                          <span className="problem-entry-meta">
                            {entry.source ? ` ${entry.source}` : ""}
                            {entry.code ? `${entry.source ? " " : " "}${entry.code}` : ""}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {activeCategory === "output" && (
            <div className="debug-console-panel">
              <div className="debug-console-toolbar">
                <div className="debug-console-filter-group">
                  <span className="debug-console-filter-label">Channel</span>
                  {OUTPUT_KINDS.map((kind) => (
                    <button
                      key={kind}
                      className={`debug-console-filter-chip debug-console-filter-chip-output${outputKindFilters[kind] ? " active" : ""}`}
                      onClick={() => toggleOutputKindFilter(kind)}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
                <button className="debug-console-reset" onClick={resetOutputFilters}>
                  Reset Filters
                </button>
              </div>
              {outputEntries.length === 0 ? (
                <div className="debug-console-empty">No output.</div>
              ) : filteredOutputEntries.length === 0 ? (
                <div className="debug-console-empty">No output matches the current filters.</div>
              ) : (
                <div className="debug-console-list">
                  {filteredOutputEntries.map((entry) => (
                    <div key={entry.id} className={`debug-console-entry debug-console-entry-${entry.kind === "error" ? "error" : entry.kind === "result" ? "info" : "log"}`}>
                      <span className="debug-console-time">{new Date(entry.time).toLocaleTimeString()}</span>
                      <span className={`debug-console-badge debug-console-badge-output debug-console-badge-output-${entry.kind}`}>{entry.kind}</span>
                      <span className="debug-console-text">{entry.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {activeCategory === "debugConsole" && (
            <div className="debug-console-panel">
              <div className="debug-console-toolbar">
                <div className="debug-console-filter-group">
                  <span className="debug-console-filter-label">Source</span>
                  {DEBUG_SOURCES.map((source) => (
                    <button
                      key={source}
                      className={`debug-console-filter-chip${debugSourceFilters[source] ? " active" : ""}`}
                      onClick={() => toggleDebugSourceFilter(source)}
                    >
                      {source}
                    </button>
                  ))}
                </div>
                <div className="debug-console-filter-group">
                  <span className="debug-console-filter-label">Level</span>
                  {DEBUG_LEVELS.map((level) => (
                    <button
                      key={level}
                      className={`debug-console-filter-chip debug-console-filter-chip-${level}${debugLevelFilters[level] ? " active" : ""}`}
                      onClick={() => toggleDebugLevelFilter(level)}
                    >
                      {level}
                    </button>
                  ))}
                </div>
                <button className="debug-console-reset" onClick={resetDebugFilters}>
                  Reset Filters
                </button>
              </div>
              {debugEntries.length === 0 ? (
                <div className="debug-console-empty">No debug output.</div>
              ) : filteredDebugEntries.length === 0 ? (
                <div className="debug-console-empty">No debug output matches the current filters.</div>
              ) : (
                <div className="debug-console-list">
                  {filteredDebugEntries.map((entry) => (
                    <div key={entry.id} className={`debug-console-entry debug-console-entry-${entry.level}`}>
                      <span className="debug-console-time">{new Date(entry.time).toLocaleTimeString()}</span>
                      <span className={`debug-console-badge debug-console-badge-${entry.source}`}>{entry.source}</span>
                      <span className="debug-console-text">{entry.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
