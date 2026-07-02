import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import type { AgentTerminalBridge } from "./AgentTerminalBridge";

// ── Rich message types for the unified agent chat ──

interface ConsoleMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  when: number;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  thought?: string;
  state?: "thinking" | "generating" | "waiting" | "file_viewing";
  viewingFile?: string;
  pendingDiff?: { path: string; content: string };
  permissionPrompt?: string;
  sandboxOutput?: string;
  /** Structured todo list (rendered as a checklist card in the console). */
  todos?: TodoItem[];
  /** Pending file change operations with diff stats (rendered as file-change cards). */
  fileChanges?: FileChange[];
  /** True if this system message is a warning (amber accent). */
  isWarning?: boolean;
}

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface FileChange {
  path: string;
  name: string;
  /** Streaming in progress, or finalized. */
  status: "streaming" | "done";
  /** Token count received so far (shown while streaming). */
  tokenCount?: number;
  /** Number of lines added / removed (shown when done). */
  linesAdded?: number;
  linesRemoved?: number;
  /** New file content (for write_file accept). */
  content?: string;
  /** Original file content before the write (for reject/restore). */
  originalContent?: string | null;
  /** Whether this change has been accepted or rejected. */
  accepted?: boolean;
  rejected?: boolean;
  /** Kind of change: "write" (default), "create" (new dir), "delete", "rename". */
  changeType?: "write" | "create" | "delete" | "rename";
}

interface ChatThread {
  id: string;
  title: string;
  messages: ConsoleMessage[];
  createdAt: number;
}

let _mid = 0;
function nextId() { return String(++_mid); }
/** Ensure the global counter is ahead of all message IDs in an array. */
function syncMid(messages: ConsoleMessage[]) {
  if (messages.length === 0) return;
  const maxId = messages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0);
  if (_mid <= maxId) _mid = maxId + 1;
}

const STORAGE_PREFIX = "harness-chat-threads";

function storageKey(projectPath: string): string {
  // Normalize path to a stable key (replace backslashes, strip trailing slash)
  const norm = (projectPath || "").replace(/\\/g, "/").replace(/\/$/, "") || "default";
  return `${STORAGE_PREFIX}:${norm}`;
}

function loadThreads(key: string): ChatThread[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveThreads(key: string, threads: ChatThread[]) {
  try {
    localStorage.setItem(key, JSON.stringify(threads));
  } catch { /* quota exceeded or serialization error — silently ignore */ }
}

function getStoredModel(): string {
  try { return localStorage.getItem("harness-model") || ""; } catch { return ""; }
}
function getStoredApiKey(): string {
  try { return localStorage.getItem("harness-api-key") || ""; } catch { return ""; }
}
function getStoredThinking(): boolean {
  try { return localStorage.getItem("harness-thinking") === "true"; } catch { return false; }
}

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}

// ── Props ──
interface Props {
  goal: string;
  onGoalChange: (value: string) => void;
  getConsoleContext?: () => string;
  executeBrowserAction?: (name: string, params: Record<string, unknown>) => Promise<string>;
  getProjectFiles?: () => Promise<string[]>;
  getFsBasePath?: () => string;
  /** Reflect a file change in the editor (open tab, set content). */
  refreshEditor?: (files: { name: string; content: string; fsPath?: string; isNew?: boolean }[]) => void;
  /** Apply agent file changes with original content for diff highlighting. */
  applyAgentFileChanges?: (changes: { name: string; content: string; fsPath?: string; originalContent?: string | null }[]) => void;
  /** Refresh the file explorer panel. */
  onRefreshFs?: () => void;
  /** Set a ref that EditorPane can call when banner accept/reject happens. */
  setAgentFileActionRef?: (fn: (fcPath: string, accepted: boolean) => void) => void;
  /** Called when user wants to open a file in the editor (diff button, etc.) */
  openEditorFile?: (path: string) => void;
  /** Accept agent change on a file (clears Monaco diff decorations). */
  acceptEditorChange?: (fsPath: string) => void;
  /** Reject agent change on a file (restores original in Monaco). */
  rejectEditorChange?: (fsPath: string) => void;
  /** Agent ↔ terminal bridge — when agent runs a command it spawns in a real terminal */
  agentTerminalBridge?: AgentTerminalBridge;
}

// ── Component ──

export default function AgentConsole({ goal, onGoalChange, getConsoleContext, executeBrowserAction, getProjectFiles, getFsBasePath, refreshEditor, applyAgentFileChanges, onRefreshFs, setAgentFileActionRef, openEditorFile, acceptEditorChange, rejectEditorChange, agentTerminalBridge }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ConsoleMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const preRoundRef = useRef<ConsoleMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const actionClickLockRef = useRef(0);
  const permissionResolveRef = useRef<((granted: boolean) => void) | null>(null);
  const agentDoneRef = useRef(false);
  // Agent completion footer state
  const [agentStatus, setAgentStatus] = useState<"idle" | "completed" | "stopped">("idle");
  const [agentUsage, setAgentUsage] = useState<{ estimatedTokens: number; contextLimit: number; turns: number } | null>(null);
  // Track which terminal outputs are collapsed (keyed by message id)
  const [collapsedOutputs, setCollapsedOutputs] = useState<Set<string>>(new Set());
  // Track agent terminal output streaming from the bridge
  const agentTermMsgIdRef = useRef<string | null>(null);
  const agentTermOutputRef = useRef<string>("");

  // Subscribe to terminal output from the bridge
  useEffect(() => {
    if (!agentTerminalBridge) return;
    const unsubOut = agentTerminalBridge.onOutput((text) => {
      agentTermOutputRef.current += text;
      const msgId = agentTermMsgIdRef.current;
      if (msgId) {
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === msgId);
          if (idx >= 0) next[idx] = { ...next[idx], sandboxOutput: agentTermOutputRef.current };
          return next;
        });
      }
    });
    const unsubFin = agentTerminalBridge.onFinish((exitCode) => {
      agentTermOutputRef.current += `\n[Process exited code=${exitCode}]`;
      const msgId = agentTermMsgIdRef.current;
      if (msgId) {
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === msgId);
          if (idx >= 0) next[idx] = { ...next[idx], sandboxOutput: agentTermOutputRef.current, state: undefined };
          return next;
        });
        agentTermMsgIdRef.current = null;
        agentTermOutputRef.current = "";
      }
    });
    return () => { unsubOut(); unsubFin(); };
  }, [agentTerminalBridge]);

  // ── Model selection ──
  interface ModelPreset {
    id: string;
    model: string;
    thinking: boolean;
  }
  function getStoredPresets(): ModelPreset[] {
    try { return JSON.parse(localStorage.getItem("harness-presets") || "[]"); } catch { return []; }
  }
  function saveStoredPresets(ps: ModelPreset[]) {
    localStorage.setItem("harness-presets", JSON.stringify(ps));
  }

  const storedPresets = useMemo(() => getStoredPresets(), []);
  const [presets, setPresets] = useState<ModelPreset[]>(storedPresets);
  // Active preset id (null = custom un-saved config)
  const [activePresetId, setActivePresetId] = useState<string>(() => {
    try { return localStorage.getItem("harness-active-preset") || ""; } catch { return ""; }
  });
  const activePreset = useMemo(() => presets.find((p) => p.id === activePresetId) || null, [presets, activePresetId]);

  // Global API key (one per user)
  const [apiKey, setApiKey] = useState<string>(getStoredApiKey);
  // Model/thinking from active preset or manual entry
  const [selectedModel, setSelectedModel] = useState<string>(() => activePreset?.model || getStoredModel());
  const [isThinking, setIsThinking] = useState<boolean>(() => activePreset?.thinking ?? getStoredThinking());

  // Sync model/thinking from activePreset when it changes
  useEffect(() => {
    if (activePreset) {
      setSelectedModel(activePreset.model);
      setIsThinking(activePreset.thinking);
    }
  }, [activePreset]);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [tempApiKey, setTempApiKey] = useState("");
  const [editModelInput, setEditModelInput] = useState(selectedModel);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Save/update a preset — dedup by model id
  const saveAsPreset = useCallback(() => {
    const model = editModelInput.trim() || "deepseek-chat";
    // Remove any existing preset with the same model id
    const filtered = presets.filter((p) => p.model !== model);
    if (activePreset) {
      const next = filtered.map((p) => p.id === activePreset.id ? { ...p, model, thinking: isThinking } : p);
      if (!next.find((p) => p.id === activePreset.id)) next.push({ id: activePreset.id, model, thinking: isThinking });
      setPresets(next); saveStoredPresets(next);
    } else {
      const p: ModelPreset = { id: `pr-${Date.now()}`, model, thinking: isThinking };
      const next = [...filtered, p];
      setPresets(next); saveStoredPresets(next);
      setActivePresetId(p.id);
      localStorage.setItem("harness-active-preset", p.id);
    }
    setModelPickerOpen(false);
  }, [activePreset, isThinking, editModelInput, presets]);

  const savePresetAsNew = useCallback(() => {
    const model = editModelInput.trim() || "deepseek-chat";
    const filtered = presets.filter((p) => p.model !== model);
    const p: ModelPreset = { id: `pr-${Date.now()}`, model, thinking: isThinking };
    const next = [...filtered, p];
    setPresets(next); saveStoredPresets(next);
    setActivePresetId(p.id);
    localStorage.setItem("harness-active-preset", p.id);
    setModelPickerOpen(false);
  }, [isThinking, editModelInput, presets]);

  const deletePreset = useCallback((id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next); saveStoredPresets(next);
    if (activePresetId === id) {
      setActivePresetId("");
      localStorage.removeItem("harness-active-preset");
    }
  }, [presets, activePresetId]);

  const selectPreset = useCallback((id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) {
      setActivePresetId(id);
      localStorage.setItem("harness-active-preset", id);
      setSelectedModel(p.model);
      setIsThinking(p.thinking);
    }
    setModelPickerOpen(false);
  }, [presets]);

  const toggleThinking = useCallback(() => {
    setIsThinking((v) => { const n = !v; localStorage.setItem("harness-thinking", String(n)); return n; });
  }, []);

  const saveModelAndClose = useCallback(() => {
    const id = editModelInput.trim() || "deepseek-chat";
    setSelectedModel(id);
    localStorage.setItem("harness-model", id);
    setModelPickerOpen(false);
  }, [editModelInput]);

  const saveApiKey = useCallback(() => {
    setApiKey(tempApiKey);
    localStorage.setItem("harness-api-key", tempApiKey);
    setEditingApiKey(false);
    // Auto-focus model input if no model set yet
    if (!selectedModel) setEditModelInput("deepseek-chat");
  }, [tempApiKey, selectedModel]);

  useEffect(() => {
    setEditModelInput(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
        setEditingApiKey(false);
      }
    };
    if (modelPickerOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [modelPickerOpen]);

  // ── Editor ↔ Console sync for file accept/reject ──
  const handleBannerFileAction = useCallback((fcPath: string, accepted: boolean) => {
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (!m.fileChanges) return m;
        const updated = m.fileChanges.map((fc) => {
          if (fc.path === fcPath && !fc.accepted && !fc.rejected) {
            changed = true;
            return { ...fc, accepted, rejected: !accepted };
          }
          return fc;
        });
        return changed ? { ...m, fileChanges: updated } : m;
      });
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    setAgentFileActionRef?.(handleBannerFileAction);
  }, [setAgentFileActionRef, handleBannerFileAction]);

  // ── Thread management ──
  // Derive project path once at mount / on change. Threads are scoped to this path.
  const projectPath = getFsBasePath?.() || "";
  const threadKey = useMemo(() => storageKey(projectPath), [projectPath]);
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads(threadKey));
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [showHistory, setShowHistory] = useState(false);
  const [fileList, setFileList] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);

  // Reload threads when project path changes
  useEffect(() => {
    setThreads(loadThreads(threadKey));
    setActiveThreadId("");
    setMessages([]);
    setAgentStatus("idle");
    setAgentUsage(null);
    preRoundRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  // Load project files async for mention dropdown
  useEffect(() => {
    let active = true;
    setFileLoading(true);
    (async () => {
      const files = await (getProjectFiles?.() ?? Promise.resolve([]));
      if (active) { setFileList(files); setFileLoading(false); }
    })();
    return () => { active = false; };
  }, [getProjectFiles, messages]); // reload on messages change (files may be created)

  // Save current thread whenever messages change
  useEffect(() => {
    if (!activeThreadId || messages.length === 0) return;
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === activeThreadId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], messages };
      return next;
    });
  }, [messages, activeThreadId]);

  // Persist threads
  useEffect(() => {
    saveThreads(threadKey, threads);
  }, [threads, threadKey]);

  const ensureThread = useCallback(() => {
    if (activeThreadId && threads.some((t) => t.id === activeThreadId)) return activeThreadId;
    const id = `thread-${Date.now()}`;
    const t: ChatThread = { id, title: `Chat ${threads.length + 1}`, messages: [], createdAt: Date.now() };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setMessages([]);
    setAgentStatus("idle");
    setAgentUsage(null);
    return id;
  }, [activeThreadId, threads]);

  const newTask = useCallback(() => {
    const id = `thread-${Date.now()}`;
    const t: ChatThread = { id, title: `Chat ${threads.length + 1}`, messages: [], createdAt: Date.now() };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setMessages([]);
    setAgentStatus("idle");
    setAgentUsage(null);
  }, [threads]);

  const selectThread = useCallback((id: string) => {
    const t = threads.find((t) => t.id === id);
    if (t) {
      setActiveThreadId(id);
      setMessages(t.messages);
      preRoundRef.current = [];
      _mid = t.messages.length > 0 ? Math.max(...t.messages.map((m) => Number(m.id) || 0)) + 1 : 0;
    }
    setShowHistory(false);
  }, [threads]);

  const deleteThread = useCallback((id: string) => {
    setThreads((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // Immediately flush to localStorage to prevent stale-data races
      saveThreads(threadKey, next);
      return next;
    });
    if (activeThreadId === id) {
      setActiveThreadId("");
      setMessages([]);
      setAgentStatus("idle");
      setAgentUsage(null);
      preRoundRef.current = [];
    }
    // Clear server-side agent session for this thread
    fetch(`/api/chat/agent/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }, [activeThreadId, threadKey]);

  // Update thread title from first user message
  const updateThreadTitle = useCallback((content: string) => {
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === activeThreadId);
      if (idx === -1 || prev[idx].title !== `Chat ${idx + 1}`) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], title: content.slice(0, 60) + (content.length > 60 ? "..." : "") };
      return next;
    });
  }, [activeThreadId]);

  // Export current chat as markdown file
  const exportChat = useCallback(() => {
    const lines: string[] = ["# Chat Export\n"];
    for (const msg of messages) {
      const time = new Date(msg.when).toISOString().slice(11, 19);
      if (msg.role === "user") {
        lines.push(`### User (${time})\n${msg.content}\n`);
      } else if (msg.role === "assistant") {
        lines.push(`### Assistant (${time})\n${msg.content}\n`);
        if (msg.thought) lines.push(`<details><summary>Thought process</summary>\n\n${msg.thought}\n\n</details>\n`);
      } else if (msg.role === "tool") {
        lines.push(`#### Tool: ${msg.toolName || "?"} (${time})\n\`\`\`\n${msg.content}\n\`\`\`\n`);
        if (msg.sandboxOutput) lines.push(`<details><summary>Terminal output</summary>\n\n\`\`\`\n${msg.sandboxOutput}\n\`\`\`\n\n</details>\n`);
      } else {
        lines.push(`#### System (${time})\n${msg.content}\n`);
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  // ── File mention autocomplete ──
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionQuery = useMemo(() => {
    const idx = input.lastIndexOf("#");
    if (idx === -1) return "";
    const after = input.slice(idx + 1);
    // If there's a space after '#', the user aborted — close dropdown.
    if (after.includes(" ")) return "\x00"; // sentinel: invalid
    return after.toLowerCase();
  }, [input]);

  const mentionActive = mentionQuery !== "\x00" && input.lastIndexOf("#") >= 0;

  const projectFiles = useMemo(() => fileList.map((p) => {
    const rel = p.replace(/\\/g, "/");
    const trimmed = rel.length > 80 ? "..." + rel.slice(-77) : rel;
    return { full: p, display: trimmed, name: p.split(/[/\\]/).pop() || p };
  }), [fileList]);

  const filteredFiles = useMemo(() => {
    if (!mentionQuery) return projectFiles.slice(0, 20);
    const q = mentionQuery;
    const matches = projectFiles.filter(
      (f) => f.display.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)
    );
    matches.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q ? 0 : 1;
      const bExact = b.name.toLowerCase() === q ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.display.length - b.display.length;
    });
    return matches.slice(0, 12);
  }, [mentionQuery, projectFiles]);

  const insertMention = useCallback((filePath: string) => {
    const idx = input.lastIndexOf("#");
    if (idx === -1) return;
    const before = input.slice(0, idx);
    const after = input.slice(idx + 1);
    const space = after.match(/^[^\s]*\s*/)?.[0]?.length || after.length;
    const rest = after.slice(space);
    setInput(before + filePath + " " + rest);
    setMentionOpen(false);
    inputRef.current?.focus();
  }, [input]);

  const closeMention = useCallback(() => setMentionOpen(false), []);

  useEffect(() => {
    // Open/close mention based on whether we have a live # with no spaces after it.
    if (mentionActive && !mentionOpen) { setMentionOpen(true); setMentionIndex(0); }
    else if (!mentionActive && mentionOpen) { setMentionOpen(false); }
  }, [mentionActive, mentionOpen]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // ── Message helpers ──

  const push = useCallback((msg: Omit<ConsoleMessage, "id" | "when">) => {
    setMessages((prev) => [...prev, { ...msg, id: nextId(), when: Date.now() }]);
  }, []);

  const updateLast = useCallback((patch: Partial<ConsoleMessage>) => {
    setMessages((prev) => prev.length === 0 ? prev : [...prev.slice(0, -1), { ...prev[prev.length - 1], ...patch }]);
  }, []);

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      // Delete from this message through the end of this turn
      // (all messages until the next user message, exclusive)
      let end = idx + 1;
      while (end < prev.length && prev[end].role !== "user") end++;
      return [...prev.slice(0, idx), ...prev.slice(end)];
    });
  }, []);

  const revertToPreRound = useCallback(() => {
    setMessages(preRoundRef.current);
  }, []);

  const handleActionClick = useCallback((fn: () => void) => {
    const now = Date.now();
    if (now - actionClickLockRef.current < 800) return;
    actionClickLockRef.current = now;
    fn();
  }, []);

  const copyText = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  // ── Streaming agent loop ──
  const streamToolRef = useRef<Map<string, { name: string; params: Record<string, unknown> }>>(new Map());
  const fileChangesRef = useRef<FileChange[]>([]);
  const pendingFileChangesRef = useRef<FileChange[]>([]); // survives tool_start clear → used in tool_end
  const todosRef = useRef<TodoItem[]>([]);

  const applyEditorFiles = useCallback((changes: FileChange[]) => {
    if (!refreshEditor && !applyAgentFileChanges) return;
    const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
    const files = changes
      .filter((fc) => fc.status === "done" && fc.content && !fc.rejected)
      .map((fc) => {
        let resolved = fc.path;
        // Resolve relative paths (from agent tool calls) to absolute.
        if (root && !/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith("/")) {
          resolved = root + "/" + resolved.replace(/\\/g, "/");
        }
        return { name: fc.path.split(/[/\\]/).pop() || fc.path, content: fc.content!, fsPath: resolved, isNew: true, originalContent: fc.originalContent };
      });
    if (files.length > 0) {
      if (applyAgentFileChanges) {
        applyAgentFileChanges(files);
      } else {
        refreshEditor?.(files);
      }
    }
  }, [refreshEditor, applyAgentFileChanges, getFsBasePath]);

  const runAgent = useCallback(async (userMessage: string, signal: AbortSignal) => {
    const consoleSnapshot = getConsoleContext?.() || "";
    // Append current terminal output if available (from running run_in_terminal commands)
    const termOut = agentTermOutputRef.current || "";
    const fullContext = termOut
      ? `${consoleSnapshot}\n### Terminal Output ###\n${termOut.slice(-2000)}`
      : consoleSnapshot;
    const root = getFsBasePath?.() || "";
    agentDoneRef.current = false;
    streamToolRef.current = new Map();
    fileChangesRef.current = [];
    pendingFileChangesRef.current = [];
    todosRef.current = [];
    // SSE streaming helpers
    const consumeSSE = async (url: string, body: Record<string, unknown>, onEvent: (evt: any) => Promise<boolean>) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Parse SSE lines: "data: <json>\n\n"
        const lines = buf.split("\n\n");
        buf = lines.pop() || ""; // last partial line stays in buffer
        for (const block of lines) {
          const m = block.match(/^data:\s*(.+)/);
          if (!m) continue;
          try {
            const evt = JSON.parse(m[1]);
            const shouldContinue = await onEvent(evt);
            if (!shouldContinue) return;
          } catch (e) { /* skip malformed */ }
        }
      }
    };

    // Start streaming session
    let sessionId = "";
    let toolCallId = "";
    let isPermission = false;
    let agentDone = false;
    let currentThought = "";
    let currentText = "";
    let assistantMsgId: string | null = null;
    const toolIds: string[] = []; // track tool messages within this round

    try {
      await consumeSSE("/api/chat/agent/stream", { message: userMessage, context: fullContext, projectRoot: root, model: selectedModel, apiKey: apiKey || undefined }, async (evt) => {
        if (signal.aborted) return false;
        sessionId = evt.sessionId || sessionId;

        if (evt.type === "thinking") {
          currentThought += (evt.text || "");
          if (!assistantMsgId) {
            assistantMsgId = nextId();
            setMessages((prev) => [...prev, { id: assistantMsgId!, role: "assistant", content: "", when: Date.now(), state: "thinking", thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined }]);
          } else {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], thought: currentThought, state: "thinking", fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined };
              return next;
            });
          }
        } else if (evt.type === "text") {
          currentText += (evt.text || "");
          if (!assistantMsgId) {
            assistantMsgId = nextId();
            setMessages((prev) => [...prev, { id: assistantMsgId!, role: "assistant", content: currentText, when: Date.now(), state: "generating", thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined }]);
          } else {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], content: currentText, state: "generating", fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined };
              return next;
            });
          }
        } else if (evt.type === "tool_start") {
          // Track file changes from write_file, delete_file, create_directory
          const tn = evt.toolName;
          if (tn === "write_file" && evt.toolParams?.path) {
            const p = String(evt.toolParams.path);
            const name = p.split(/[/\\]/).pop() || p;
            const content = String(evt.toolParams.content || "");
            const tokenCount = Math.round(content.length / 4);
            fileChangesRef.current.push({
              path: p, name, content, changeType: "write",
              status: "streaming",
              tokenCount,
              originalContent: (evt as any).originalContent ?? null,
            });
          } else if (tn === "edit_file" && evt.toolParams?.path) {
            const p = String(evt.toolParams.path);
            const name = p.split(/[/\\]/).pop() || p;
            const oldStr = String(evt.toolParams.old_string || "");
            const newStr = String(evt.toolParams.new_string || "");
            const orig = (evt as any).originalContent;
            // Compute full new content: apply the replacement to originalContent
            const content = orig ? orig.split(oldStr).join(newStr) : newStr;
            const tokenCount = Math.round(content.length / 4);
            fileChangesRef.current.push({
              path: p, name, content, changeType: "write",
              status: "streaming",
              tokenCount,
              originalContent: orig ?? null,
            });
          } else if (tn === "delete_file" && evt.toolParams?.path) {
            const p = String(evt.toolParams.path);
            const name = p.split(/[/\\]/).pop() || p;
            fileChangesRef.current.push({
              path: p, name, changeType: "delete",
              status: "done",
              originalContent: (evt as any).originalContent ?? null,
            });
          } else if (tn === "create_directory" && evt.toolParams?.path) {
            const p = String(evt.toolParams.path);
            const name = p.split(/[/\\]/).pop() || p;
            fileChangesRef.current.push({
              path: p, name, changeType: "create",
              status: "done",
            });
          } else if (tn === "rename_file" && evt.toolParams?.oldPath) {
            const oldP = String(evt.toolParams.oldPath);
            const newP = String(evt.toolParams.newPath || "");
            const name = oldP.split(/[/\\]/).pop() || oldP;
            fileChangesRef.current.push({
              path: oldP, name, changeType: "rename",
              status: "done",
              content: newP, // stash new path in content for accept
              originalContent: oldP, // stash old path in originalContent for reject
            });
          } else if (tn === "write_todos" && Array.isArray(evt.toolParams?.todos)) {
            todosRef.current = (evt.toolParams.todos as any[]).map((t: any): TodoItem => ({
              id: String(t.id || ""),
              text: String(t.text || ""),
              status: (["pending", "in_progress", "completed", "cancelled"].includes(String(t.status)) ? String(t.status) : "pending") as TodoItem["status"],
            }));
          }
          // End the assistant message's streaming state
          if (assistantMsgId) {
            flushSync(() => {
              setMessages((prev) => {
                const next = [...prev];
                const idx = next.findIndex((m) => m.id === assistantMsgId);
                if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
                return next;
              });
            });
            assistantMsgId = null;
            // Save changes for tool_end (ref is cleared below)
            if (fileChangesRef.current.length > 0) {
              pendingFileChangesRef.current = fileChangesRef.current;
            }
            // Clear so the next assistant message doesn't re-attach old file changes
            fileChangesRef.current = [];
            todosRef.current = [];
          }
          currentThought = "";
          currentText = "";
          const isTerminal = evt.toolName === "run_in_terminal";
          const id = nextId();
          toolIds.push(id);
          streamToolRef.current.set(id, { name: evt.toolName, params: evt.toolParams || {} });
          // For run_in_terminal: defer card creation to permission_required event.
          // The command will NOT run until user clicks Allow.
          if (!isTerminal) {
            flushSync(() => {
              pushRaw(id, { role: "tool", content: "", toolName: evt.toolName, toolParams: evt.toolParams, state: "waiting", sandboxOutput: evt.toolName === "run_command" ? "" : undefined });
            });
          } else {
            // Store the command so permission_required can use it (does not run yet)
            agentTermMsgIdRef.current = id;
            agentTermOutputRef.current = "";
          }
        } else if (evt.type === "tool_end") {
          // Switch file changes from streaming to done and auto-apply to editor.
          const tn = evt.toolName;
          if (tn === "write_file" || tn === "edit_file") {
            setMessages((prev) => {
              let changed = false;
              const next = prev.map((m) => {
                if (!m.fileChanges) return m;
                const updated = m.fileChanges.map((fc) => {
                  if (fc.status === "streaming") {
                    changed = true;
                    return { ...fc, status: "done" as const, linesAdded: Math.max(1, Math.round((fc.tokenCount ?? 0) / 40)), linesRemoved: 0 };
                  }
                  return fc;
                });
                return changed ? { ...m, fileChanges: updated } : m;
              });
              return changed ? next : prev;
            });
            // Also mutate the saved pending changes so applyEditorFiles picks them up
            for (const fc of pendingFileChangesRef.current) {
              if (fc.status === "streaming") {
                fc.status = "done";
                fc.linesAdded = Math.max(1, Math.round((fc.tokenCount ?? 0) / 40));
                fc.linesRemoved = 0;
              }
            }
            // Auto-apply file changes to editor so the open file gets updated content
            // Uses pendingFileChangesRef (saved from tool_start before ref was cleared)
            if (pendingFileChangesRef.current.length > 0) {
              applyEditorFiles([...pendingFileChangesRef.current]);
              pendingFileChangesRef.current = [];
            }
            // Refresh file tree — write_file already wrote to disk in the agent loop.
            onRefreshFs?.();
          } else if (tn === "delete_file" || tn === "create_directory" || tn === "rename_file") {
            onRefreshFs?.();
          }
          const id = toolIds[toolIds.length - 1];
          const isTerminal = evt.toolName === "run_in_terminal";
          if (id) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === id);
              if (idx >= 0) {
                const patch: Partial<ConsoleMessage> = { content: isTerminal ? "" : (evt.toolResult || ""), state: undefined };
                // Only override sandboxOutput if the server actually sent one
                if (evt.toolSandbox != null) patch.sandboxOutput = evt.toolSandbox;
                next[idx] = { ...next[idx], ...patch };
              }
              return next;
            });
          }
        } else if (evt.type === "permission_required") {
          toolCallId = evt.toolCallId || "";
          isPermission = true;
          // End assistant streaming state
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
              return next;
            });
            assistantMsgId = null;
          }
          currentThought = "";
          currentText = "";
          // Reuse the ID already reserved by tool_start (stored in toolIds / agentTermMsgIdRef)
          const id = agentTermMsgIdRef.current || toolIds[toolIds.length - 1];
          pushRaw(id, {
            role: "tool",
            content: "",
            toolName: evt.toolName || "run_in_terminal",
            toolParams: evt.toolParams,
            state: "waiting",
            permissionPrompt: `Allow: ${(evt as any).permissionCommand || "unknown command"}`,
          });
          return false; // stop — wait for user to Allow/Deny
        } else if (evt.type === "browser_tool") {
          toolCallId = evt.toolCallId || "";
          // Show the browser tool being executed
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
              return next;
            });
            assistantMsgId = null;
          }
          currentThought = "";
          currentText = "";
          // Reuse the existing tool card from tool_start if this tool was already tracked
          const tn = evt.toolName || "";
          const existingId = toolIds.length > 0 ? toolIds[toolIds.length - 1] : null;
          const reuseExisting = existingId && streamToolRef.current.get(existingId)?.name === tn;
          const id = reuseExisting ? existingId : nextId();
          if (!reuseExisting) toolIds.push(id);
          streamToolRef.current.set(id, { name: tn, params: evt.toolParams || {} });
          pushRaw(id, { role: "tool", content: "", toolName: tn, toolParams: evt.toolParams, state: "waiting" });
          return false; // stop consuming this SSE stream
        } else if (evt.type === "done") {
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
              return next;
            });
          }
          currentThought = "";
          currentText = "";
          if (evt.reply && !assistantMsgId) {
            push({ role: "assistant", content: evt.reply, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined });
          }
          setAgentStatus("completed");
          if (evt.usage) setAgentUsage(evt.usage);
          onRefreshFs?.();
          setLoading(false);
          return false;
        } else if (evt.type === "warning") {
          push({ role: "system", content: `\u26A0 ${evt.warning || ""}`, isWarning: true });
          return true; // continue consuming
        } else if (evt.type === "error") {
          push({ role: "system", content: `Error: ${evt.error || "Unknown"}` });
          setAgentStatus("stopped");
          setLoading(false);
          return false;
        }
        return true; // continue consuming
      });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        push({ role: "system", content: `Error: ${String(err)}` });
      }
      setLoading(false);
    }

    // ── Shared SSE event handler for continue loops ──
    // Handles ALL event types consistently (thinking, text, tool_start, tool_end,
    // done, warning, error, browser_tool, permission_required).
    const handleContinueEvent = (evt: any): Promise<boolean> => {
      return (async (): Promise<boolean> => {
        if (signal.aborted) return false;
        const tn = evt.toolName || "";

        if (evt.type === "thinking") {
          currentThought += (evt.text || "");
          if (!assistantMsgId) {
            assistantMsgId = nextId();
            pushRaw(assistantMsgId, { role: "assistant", content: "", state: "thinking", thought: currentThought });
          } else {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], thought: currentThought, state: "thinking" };
              return next;
            });
          }
          return true;
        }

        if (evt.type === "text") {
          currentText += (evt.text || "");
          if (!assistantMsgId) {
            assistantMsgId = nextId();
            pushRaw(assistantMsgId, { role: "assistant", content: currentText, state: "generating", thought: currentThought });
          } else {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], content: currentText, state: "generating" };
              return next;
            });
          }
          return true;
        }

        if (evt.type === "tool_start") {
          // End assistant streaming, flush file changes to the assistant message
          if (assistantMsgId) {
            flushSync(() => {
              setMessages((prev) => {
                const next = [...prev];
                const idx = next.findIndex((m) => m.id === assistantMsgId);
                if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
                return next;
              });
            });
            assistantMsgId = null;
            fileChangesRef.current = [];
            todosRef.current = [];
          }
          currentThought = "";
          currentText = "";
          const id = nextId();
          toolIds.push(id);
          streamToolRef.current.set(id, { name: tn, params: evt.toolParams || {} });
          pushRaw(id, { role: "tool", content: "", toolName: tn, toolParams: evt.toolParams, state: "waiting", sandboxOutput: tn === "run_command" ? "" : undefined });
          return true;
        }

        if (evt.type === "tool_end") {
          // Update the last tool card (the one most recently started)
          const id = toolIds[toolIds.length - 1];
          if (id) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === id);
              if (idx >= 0) {
                const patch: Partial<ConsoleMessage> = { content: evt.toolResult || "", state: undefined };
                if (evt.toolSandbox != null) patch.sandboxOutput = evt.toolSandbox;
                next[idx] = { ...next[idx], ...patch };
              }
              return next;
            });
          }
          // Refresh files / apply changes
          if (tn === "write_file" || tn === "edit_file" || tn === "delete_file" || tn === "create_directory" || tn === "rename_file") {
            onRefreshFs?.();
          }
          return true;
        }

        if (evt.type === "done") {
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought };
              return next;
            });
          } else if (evt.reply) {
            push({ role: "assistant", content: evt.reply, thought: currentThought });
          }
          setAgentStatus("completed");
          if (evt.usage) setAgentUsage(evt.usage);
          onRefreshFs?.();
          setLoading(false);
          agentDoneRef.current = true;
          return false;
        }

        if (evt.type === "warning") {
          push({ role: "system", content: `\u26A0 ${evt.warning || ""}`, isWarning: true });
          return true;
        }

        if (evt.type === "error") {
          push({ role: "system", content: `Error: ${evt.error || "Unknown"}` });
          setAgentStatus("stopped");
          setLoading(false);
          agentDoneRef.current = true;
          return false;
        }

        if (evt.type === "browser_tool") {
          toolCallId = evt.toolCallId || "";
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
              return next;
            });
            assistantMsgId = null;
          }
          currentThought = "";
          currentText = "";
          fileChangesRef.current = [];
          todosRef.current = [];
          // Reuse the existing tool card from tool_start if this tool was already tracked
          const existingId = toolIds.length > 0 ? toolIds[toolIds.length - 1] : null;
          const reuseExisting = existingId && streamToolRef.current.get(existingId)?.name === tn;
          const id = reuseExisting ? existingId : nextId();
          if (!reuseExisting) toolIds.push(id);
          streamToolRef.current.set(id, { name: tn, params: evt.toolParams || {} });
          pushRaw(id, { role: "tool", content: "", toolName: tn, toolParams: evt.toolParams, state: "waiting" });
          isPermission = false;
          return false; // stop — resume via while loop
        }

        if (evt.type === "permission_required") {
          toolCallId = evt.toolCallId || "";
          isPermission = true;
          return false; // stop — wait for user
        }

        return true; // consume unknown events
      })();
    };

    // ── Helper: continue streaming with the shared handler ──
    const continueStreaming = async (body: Record<string, unknown>) => {
      try {
        await consumeSSE("/api/chat/agent/stream/continue", body, handleContinueEvent);
      } catch (err: any) {
        if (err?.name !== "AbortError") push({ role: "system", content: `Error: ${String(err)}` });
      }
    };

    // ── Loop: keep processing browser_tool / permission_required until done ──
    while (!agentDoneRef.current && sessionId && toolCallId) {

    // If permission is needed, wait for user response then continue
    if (isPermission) {
      if (signal.aborted) { setLoading(false); return; }
      const granted = await new Promise<boolean>((resolve) => {
        permissionResolveRef.current = resolve;
      });
      permissionResolveRef.current = null;
      const permMsgId = agentTermMsgIdRef.current || toolIds[toolIds.length - 1];
      const permTool = permMsgId ? streamToolRef.current.get(permMsgId) : undefined;

      if (!granted && permMsgId) {
        // Denied — remove the tool card
        setMessages((prev) => prev.filter((m) => m.id !== permMsgId));
        agentTermMsgIdRef.current = null;
        agentTermOutputRef.current = "";
      }

      if (!signal.aborted) {
        if (granted && permTool?.name === "browser_eval") {
          // browser_eval: execute in the browser, then continue with the result
          const code = String(permTool?.params?.code || "");
          let evalResult = "Browser not available.";
          if (executeBrowserAction) {
            evalResult = await executeBrowserAction("browser_eval", { code });
          }
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.findIndex((m) => m.id === permMsgId);
            if (idx >= 0) next[idx] = { ...next[idx], permissionPrompt: undefined, content: evalResult, state: undefined };
            return next;
          });
          isPermission = false;
          await continueStreaming({ sessionId, toolCallId, toolResult: evalResult, model: selectedModel || "deepseek-chat", apiKey, thinking: isThinking });
        } else {
          // Other permission-based tool (run_in_terminal, write_file, edit_file, delete_file, rename_file)
          if (permMsgId && granted) {
            // Only run_in_terminal uses the terminal bridge
            if (permTool?.name === "run_in_terminal") {
              const cmd = String(permTool?.params?.command || "");
              if (cmd && agentTerminalBridge) {
                agentTerminalBridge.setCommand({ id: permMsgId, command: cmd });
                agentTermOutputRef.current = "";
              }
            }
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === permMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], permissionPrompt: undefined };
              return next;
            });
          }
          isPermission = false;
          await continueStreaming({ sessionId, toolCallId, permissionGranted: granted, model: selectedModel || "deepseek-chat", apiKey, thinking: isThinking });
        }
      } else {
        agentDoneRef.current = true;
      }
    } else if (sessionId && toolCallId && !isPermission) {
      // If we got a browser_tool, execute it and continue
      const lastToolId = toolIds[toolIds.length - 1];
      let toolResult = "Tool not available.";
      if (executeBrowserAction) {
        const toolData = lastToolId ? streamToolRef.current.get(lastToolId) : undefined;
        if (toolData) {
          toolResult = await executeBrowserAction(toolData.name, toolData.params || {});
        }
      }
      if (lastToolId) {
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === lastToolId);
          if (idx >= 0) next[idx] = { ...next[idx], content: toolResult, state: undefined };
          return next;
        });
      }

      if (!signal.aborted) {
        await continueStreaming({ sessionId, toolCallId, toolResult, model: selectedModel || "deepseek-chat", apiKey, thinking: isThinking });
      } else {
        agentDoneRef.current = true;
      }
    }
    }

    setLoading(false);
  }, [getConsoleContext, executeBrowserAction, push, getFsBasePath, applyEditorFiles, onRefreshFs]);

  // helper: push a message with explicit id
  const pushRaw = useCallback((id: string, msg: Omit<ConsoleMessage, "id" | "when">) => {
    setMessages((prev) => {
      // Update if message with this ID already exists (prevents "same key" errors)
      const idx = prev.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...msg, id, when: Date.now() };
        return next;
      }
      return [...prev, { ...msg, id, when: Date.now() }];
    });
  }, []);

  // ── Send / Stop ──

  const send = useCallback(async () => {
    const msg = input.trim();
    if (!msg) return;
    ensureThread();
    updateThreadTitle(msg);
    setInput("");
    onGoalChange(msg);
    setLoading(true);
    setAgentStatus("idle");
    setAgentUsage(null);
    setThumbsFeedback(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    preRoundRef.current = messages;
    push({ role: "user", content: msg });

    try {
      await runAgent(msg, ctrl.signal);
    } catch (err: any) {
      if (err?.name !== "AbortError") push({ role: "assistant", content: `Error: ${String(err)}` });
      setLoading(false);
    }
    abortRef.current = null;
  }, [input, runAgent, push, messages, ensureThread, updateThreadTitle]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setAgentStatus("stopped");
    push({ role: "system", content: "Stopped." });
  }, [push]);

  const insertHash = useCallback(() => {
    setInput((prev) => prev + "#");
    setMentionOpen(true);
    setMentionIndex(0);
    inputRef.current?.focus();
  }, []);

  // ── Footer actions ──

  const retryLast = useCallback(() => {
    // Find the last user message and re-send its content.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) setInput(lastUser.content);
    setAgentStatus("idle");
    setAgentUsage(null);
  }, [messages]);

  const forkChat = useCallback(() => {
    const id = `thread-${Date.now()}`;
    const t: ChatThread = { id, title: `Fork of ${activeThreadId || "chat"}`, messages: [...messages], createdAt: Date.now() };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setAgentStatus("idle");
    setAgentUsage(null);
  }, [messages, activeThreadId]);

  const copyChat = useCallback(() => {
    const text = messages.map((m) => {
      const prefix = m.role === "user" ? "You" : m.role === "assistant" ? "AI" : m.toolName ? `Tool: ${m.toolName}` : "System";
      return `### ${prefix}\n${m.content}`;
    }).join("\n\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  }, [messages]);

  const [thumbsFeedback, setThumbsFeedback] = useState<"up" | "down" | null>(null);
  const feedback = useCallback((v: "up" | "down") => setThumbsFeedback(v), []);
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [expandedDiffPath, setExpandedDiffPath] = useState<string | null>(null);

  // ── Simple line-by-line diff (LCS-based unified diff) ──
  const computeUnifiedDiff = useCallback((original: string, current: string, contextLines = 3): string => {
    const oLines = original.split("\n");
    const cLines = current.split("\n");
    // LCS table
    const m = oLines.length, n = cLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = oLines[i - 1] === cLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    // Backtrack to get hunks
    let i = m, j = n;
    const rawLines: { kind: " " | "-" | "+"; text: string }[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oLines[i - 1] === cLines[j - 1]) { rawLines.unshift({ kind: " ", text: oLines[i - 1] }); i--; j--; }
      else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { rawLines.unshift({ kind: "+", text: cLines[j - 1] }); j--; }
      else { rawLines.unshift({ kind: "-", text: oLines[i - 1] }); i--; }
    }
    // Build unified diff output
    let out = "";
    for (let h = 0; h < rawLines.length; ) {
      // Find the first change in the next context window
      let changeStart = -1;
      for (let k = h; k < rawLines.length; k++) {
        if (rawLines[k].kind !== " ") { changeStart = k; break; }
      }
      if (changeStart === -1) break;
      const hunkStart = Math.max(h, changeStart - contextLines);
      // Emit context lines before
      for (let k = hunkStart; k < changeStart; k++) out += ` ${rawLines[k].text}\n`;
      // Emit changed lines
      let changeEnd = changeStart;
      while (changeEnd < rawLines.length && (rawLines[changeEnd].kind !== " " || changeEnd === changeStart || (changeEnd < rawLines.length - 1 && rawLines[changeEnd + 1]?.kind !== " "))) changeEnd++;
      // Extend trailing context
      let trailing = changeEnd;
      while (trailing < rawLines.length && trailing < changeEnd + contextLines && rawLines[trailing].kind === " ") trailing++;
      for (let k = changeStart; k < trailing; k++) out += `${rawLines[k].kind}${rawLines[k].text}\n`;
      h = trailing;
    }
    return out.trimEnd();
  }, []);

  // ── Collect changed files from the last assistant message ──
  const changedFiles = useMemo(() => {
    if (messages.length === 0) return [];
    const files: { path: string; name: string; diff: string }[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.fileChanges && m.fileChanges.length > 0) {
        for (const fc of m.fileChanges) {
          if (fc.changeType === "write" && fc.originalContent != null && fc.content) {
            files.push({ path: fc.path, name: fc.name, diff: computeUnifiedDiff(fc.originalContent || "", fc.content) });
          }
        }
        break;
      }
    }
    return files;
  }, [messages, computeUnifiedDiff]);

  // ── Pending items for the input-area banner ──
  const pendingTodos = useMemo(() => {
    const collected: (TodoItem & { msgId: string })[] = [];
    for (const m of messages) {
      if (m.todos) {
        for (const t of m.todos) {
          if (t.status !== "completed" && t.status !== "cancelled") {
            collected.push({ ...t, msgId: m.id });
          }
        }
      }
    }
    return collected;
  }, [messages]);

  const unconfirmedFileChanges: { path: string; name: string; msgId: string }[] = useMemo(() => {
    const result: { path: string; name: string; msgId: string }[] = [];
    for (const m of messages) {
      if (m.fileChanges) {
        for (const fc of m.fileChanges) {
          if (!fc.accepted && !fc.rejected) result.push({ path: fc.path, name: fc.name, msgId: m.id });
        }
      }
    }
    return result;
  }, [messages]);

  const acceptAllChanges = useCallback(() => {
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (!m.fileChanges) return m;
        const updated = m.fileChanges.map((fc) => {
          if (!fc.accepted && !fc.rejected) { changed = true; return { ...fc, accepted: true, rejected: false }; }
          return fc;
        });
        return changed ? { ...m, fileChanges: updated } : m;
      });
      // Notify editor to clear all agent diffs + refresh file tree
      if (changed) {
        onRefreshFs?.();
        for (const m of next) {
          if (m.fileChanges) {
            for (const fc of m.fileChanges) {
              if (fc.accepted && fc.path) acceptEditorChange?.(fc.path);
            }
          }
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const [showPendingBanner, setShowPendingBanner] = useState(false);

  // Clear diff panel when messages change
  useEffect(() => { setDiffPanelOpen(false); setExpandedDiffPath(null); }, [messages.length]);

  // ── Accept/reject pending diff ──

  const acceptDiff = useCallback(async (msg: ConsoleMessage) => {
    if (!msg.pendingDiff) return;
    const { path, content } = msg.pendingDiff;
    try {
      await fetch("/api/fs/create-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) });
      push({ role: "system", content: `Applied: ${path}` });
    } catch (err) {
      push({ role: "system", content: `Failed to write ${path}: ${err}` });
    }
    removeMessage(msg.id);
  }, [push, removeMessage]);

  const rejectDiff = useCallback((msg: ConsoleMessage) => {
    push({ role: "system", content: `Rejected: ${msg.pendingDiff?.path || "unknown"}` });
    removeMessage(msg.id);
  }, [push, removeMessage]);

  // ── Accept / reject file changes ──

  const acceptFile = useCallback((fc: FileChange, msgId: string) => {
    if (fc.changeType === "write" && fc.content) {
      applyEditorFiles([fc]);
    } else if (fc.changeType === "delete") {
      const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
      let resolved = fc.path;
      if (root && !/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith("/")) {
        resolved = root + "/" + resolved.replace(/\\/g, "/");
      }
      fetch("/api/fs/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: resolved }),
      }).then((r) => { if (r.ok) onRefreshFs?.(); }).catch(() => {});
    } else if (fc.changeType === "rename" && fc.content) {
      // Rename already happened on disk (server executes immediately).
      // Just acknowledge and refresh.
      onRefreshFs?.();
    }
    // For "create" — directory already exists, just acknowledge.
    if (fc.changeType !== "delete") onRefreshFs?.();
    // Sync editor: clear diff decorations for this file
    acceptEditorChange?.(fc.path);
    setMessages((prev) => {
      const next = [...prev];
      const idx = next.findIndex((m) => m.id === msgId);
      if (idx >= 0 && next[idx].fileChanges) {
        next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: true, rejected: false } : c) };
      }
      return next;
    });
  }, [acceptEditorChange, applyEditorFiles, onRefreshFs]);

  const rejectFile = useCallback((fc: FileChange, msgId: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const idx = next.findIndex((m) => m.id === msgId);
      if (idx >= 0 && next[idx].fileChanges) {
        next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: false, rejected: true } : c) };
      }
      return next;
    });
    // Revert the file on disk.
    (async () => {
      if (!fc.path) return;
      const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
      let resolved = fc.path;
      if (root && !/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith("/")) {
        resolved = root + "/" + resolved.replace(/\\/g, "/");
      }
      const hasOriginal = fc.originalContent != null;
      try {
        if (fc.changeType === "rename" && fc.content) {
          // Rename it back: newPath -> oldPath
          let newResolved = fc.content;
          if (root && !/^[a-zA-Z]:/.test(newResolved) && !newResolved.startsWith("/")) {
            newResolved = root + "/" + newResolved.replace(/\\/g, "/");
          }
          const res = await fetch("/api/fs/rename", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ oldPath: newResolved, newPath: resolved }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else if (hasOriginal) {
          const res = await fetch("/api/fs/write", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: resolved, content: fc.originalContent }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else {
          const res = await fetch("/api/fs/delete", {
            method: "DELETE", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: resolved }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
        // Notify editor + refresh tree
        rejectEditorChange?.(fc.path!);
        onRefreshFs?.();
      } catch (err) {
        console.error("Reject revert failed:", err);
      }
    })();
  }, [rejectEditorChange, getFsBasePath, onRefreshFs]);

// ── Standalone components (outside AgentConsole to avoid React key conflicts on re-render) ──

function truncPath(p: string) {
  const s = p.replace(/\\/g, "/");
  return s.length > 50 ? "..." + s.slice(-47) : s;
}

function FileChangeCard({ fc, msgId, openEditorFile, onAccept, onReject }: { fc: FileChange; msgId: string; openEditorFile?: (path: string) => void; onAccept: (fc: FileChange, msgId: string) => void; onReject: (fc: FileChange, msgId: string) => void }) {
    const isStreaming = fc.status === "streaming";
    const isResolved = fc.accepted || fc.rejected;
    const ct = fc.changeType || "write";
    const icon = isStreaming ? "loading"
      : fc.accepted ? "check"
      : fc.rejected ? "close"
      : ct === "delete" ? "trash"
      : ct === "create" ? "folder-opened"
      : ct === "rename" ? "arrow-right"
      : "diff";
    const actionLabel = ct === "delete" ? (fc.accepted ? "Deleted" : "Kept")
      : ct === "create" ? (fc.accepted ? "Created" : "Skipped")
      : ct === "rename" ? (fc.accepted ? "Renamed" : "Kept")
      : fc.accepted ? "Applied" : "Dismissed";
    return (
      <div className={`agent-fc${isStreaming ? " streaming" : ""}${isResolved ? " resolved" : ""}${fc.accepted ? " accepted" : ""}${fc.rejected ? " rejected" : ""}`}>
        <i className={`codicon codicon-${icon}`} />
        <span className="agent-fc-name">
          {isResolved ? <s>{fc.name}</s> : fc.name}
        </span>
        <span className="agent-fc-path">{truncPath(fc.path)}</span>
        {isStreaming ? (
          <>
            <span className="agent-fc-tokens"><i className="codicon codicon-arrow-down" />{fc.tokenCount ?? 0}</span>
            <span className="agent-spinner" />
          </>
        ) : !isResolved ? (
          <>
            {ct === "write" && (
              <span className="agent-fc-delta">
                {fc.linesAdded != null && <span className="agent-fc-added">+{fc.linesAdded}</span>}
                {fc.linesRemoved != null && <span className="agent-fc-removed">-{fc.linesRemoved}</span>}
              </span>
            )}
            {ct === "delete" && (
              <span className="agent-fc-delta">
                <span className="agent-fc-removed">Delete</span>
              </span>
            )}
            {ct === "create" && (
              <span className="agent-fc-delta">
                <span className="agent-fc-added">New</span>
              </span>
            )}
            {ct === "rename" && fc.content && (
              <span className="agent-fc-delta">
                <span className="agent-fc-removed">{fc.name}</span>
                <span className="agent-fc-arrow">&rarr;</span>
                <span className="agent-fc-added">{fc.content.split(/[/\\]/).pop()}</span>
              </span>
            )}
            {ct === "write" && (
              <button className="agent-fc-diff-btn" title="Open diff" onClick={(e) => { e.stopPropagation(); openEditorFile?.(fc.path); }}><i className="codicon codicon-diff" /></button>
            )}
            <div className="agent-fc-actions">
              <button className="agent-btn agent-btn-accept" onClick={(e) => { e.stopPropagation(); onAccept(fc, msgId); }} title="Accept">
                <i className="codicon codicon-check" />
              </button>
              <button className="agent-btn agent-btn-reject" onClick={(e) => { e.stopPropagation(); onReject(fc, msgId); }} title="Reject">
                <i className="codicon codicon-close" />
              </button>
            </div>
          </>
        ) : (
          <span className="agent-fc-label">{actionLabel}</span>
        )}
      </div>
    );
}

function TodoCard({ todos }: { todos: TodoItem[] }) {
    if (!todos || todos.length === 0) return null;
    const doneCount = todos.filter((t) => t.status === "completed" || t.status === "cancelled").length;
    return (
      <div className="agent-todo-card">
        <div className="agent-todo-header">
          <i className="codicon codicon-checklist" />
          <span>{doneCount}/{todos.length} done</span>
        </div>
        {todos.map((t) => {
          let icon = "circle-outline";
          if (t.status === "in_progress") icon = "loading~spin";
          else if (t.status === "completed") icon = "pass-filled";
          else if (t.status === "cancelled") icon = "circle-slash";
          return (
            <div key={t.id} className={`agent-todo-item ${t.status}`}>
              <i className={`codicon codicon-${icon}`} />
              <span className="agent-todo-text">{t.text}</span>
            </div>
          );
        })}
      </div>
    );
}

function CollapsedCode({ text, msgId }: { text: string; msgId: string }) {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return <>{parts.map((p, i) => {
      const m = p.match(/^```(\w+)?\n?([\s\S]*?)```$/);
      if (m) {
        const body = m[2].trimEnd();
        const lines = body.split("\n");
        const first = lines[0] || "";
        const fileMatch = first.match(/^(?:#|\/\/|\/\*)\s*([^\s*\/]+)/);
        const label = fileMatch ? `${fileMatch[1]} line${lines.length > 1 ? ` 1-${lines.length}` : " 1"}` : `${m[1] || "code"} ${lines.length} lines`;
        return (
          <details key={`${msgId}-cc-${i}`} className="agent-code-collapse">
            <summary className="agent-code-collapse-summary"><i className="codicon codicon-code" /> {label}</summary>
            <pre className="agent-code"><code>{body}</code></pre>
          </details>
        );
      }
      return <span key={`${msgId}-cc-${i}`}>{p}</span>;
    })}</>;
}

const iconForRole = (r: string) => r === "user" ? "account" : r === "assistant" ? "sparkle" : r === "tool" ? "tools" : "info";
const stateLabel = (s: string) => ({ thinking: "Thinking...", generating: "Generating...", waiting: "Wait a moment...", file_viewing: "Reading file..." } as Record<string, string>)[s] || "";

  // ── UI ──

  // Ensure message-id counter survives HMR (which resets module-level _mid).
  // Also filter out any corrupted messages with null/duplicate IDs from localStorage.
  const safeMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((m) => {
      if (!m.id) return false;
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [messages]);
  syncMid(safeMessages);

  return (
    <div className="console-panel">
      {/* ── Toolbar ── */}
      <div className="agent-toolbar">
        <button className="agent-toolbar-btn" onClick={newTask} title="New Task">
          <i className="codicon codicon-add" /> New Task
        </button>
        <button className="agent-toolbar-btn" onClick={() => setShowHistory((v) => !v)} title="Show History">
          <i className="codicon codicon-history" /> {showHistory ? "Hide History" : "History"}
        </button>
        {messages.length > 0 && (
          <button className="agent-toolbar-btn" onClick={exportChat} title="Export chat">
            <i className="codicon codicon-save" />
          </button>
        )}
      </div>

      {/* ── History panel ── */}
      {showHistory && (
        <div className="agent-history-panel">
          {threads.length === 0 && <div className="agent-history-empty">No saved chats.</div>}
          {threads.map((t) => (
            <div key={t.id} className={`agent-history-item${t.id === activeThreadId ? " active" : ""}`}>
              <button className="agent-history-select" onClick={() => selectThread(t.id)}>
                <span className="agent-history-title">{t.title}</span>
                <span className="agent-history-meta">{t.messages.length} messages &middot; {new Date(t.createdAt).toLocaleDateString()}</span>
              </button>
              <button className="agent-history-delete" onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }} title="Delete">
                <i className="codicon codicon-trash" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Goal display ── */}
      {goal && goal !== "Verify the app works correctly" && (
        <div className="agent-goal-bar">
          <i className="codicon codicon-target" />
          <span>{goal}</span>
          <button className="agent-goal-clear" onClick={() => onGoalChange("")} title="Clear goal">
            <i className="codicon codicon-close" />
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div className="console-list">
        {safeMessages.length === 0 && (
          <div className="agent-empty">Ask the agent to do anything — write code, run tests, browse the web, manage files...</div>
        )}
        {safeMessages.map((msg) => (
          <div key={msg.id} className={`agent-msg agent-msg-${msg.role}${msg.isWarning ? " agent-msg-warning" : ""}`}>
            {msg.state && (
              <div key={`${msg.id}-state`} className="agent-state">
                {msg.state === "thinking" && <span className="agent-spinner" />}
                {stateLabel(msg.state)}
              </div>
            )}
            {msg.viewingFile && (
              <div key={`${msg.id}-view`} className="agent-file-view"><i className="codicon codicon-eye" /> {msg.viewingFile}</div>
            )}
            {/* Sandbox only shown inside tool card for tool messages; standalone for non-tool */}
            {msg.role !== "tool" && msg.sandboxOutput && (
              <div key={`${msg.id}-term`} className="agent-terminal">
                <div className="agent-terminal-header">
                  <i className="codicon codicon-terminal" />
                  <span className="agent-terminal-cwd" title={projectPath}>{projectPath || "~"}</span>
                  <span className="agent-terminal-label">terminal</span>
                  <i className="codicon codicon-check agent-terminal-done" />
                </div>
                <pre className="agent-terminal-out">{msg.sandboxOutput}</pre>
              </div>
            )}
            {msg.permissionPrompt && msg.role !== "tool" && (
              <div key={`${msg.id}-perm`} className="agent-perms">
                <i className="codicon codicon-warning" />
                <span>{msg.permissionPrompt}</span>
                <div className="agent-perms-actions">
                  <button className="agent-btn agent-btn-accept" onClick={() => permissionResolveRef.current?.(true)}>Allow</button>
                  <button className="agent-btn agent-btn-reject" onClick={() => permissionResolveRef.current?.(false)}>Deny</button>
                </div>
              </div>
            )}
            {msg.pendingDiff && (
              <div key={`${msg.id}-diff`} className="agent-diff">
                <div className="agent-diff-header">
                  <i className="codicon codicon-diff" /> <code>{msg.pendingDiff.path}</code>
                  <span className="agent-diff-summary">{msg.pendingDiff.content.split("\n").length} lines</span>
                </div>
                <pre className="agent-diff-preview">{msg.pendingDiff.content.slice(0, 2000)}</pre>
                <div className="agent-diff-actions">
                  <button className="agent-btn agent-btn-accept" onClick={() => acceptDiff(msg)}><i className="codicon codicon-check" /> Accept</button>
                  <button className="agent-btn agent-btn-reject" onClick={() => rejectDiff(msg)}><i className="codicon codicon-close" /> Reject</button>
                </div>
              </div>
            )}
            {/* File change containers */}
            {msg.fileChanges && msg.fileChanges.length > 0 && (
              <div key={`${msg.id}-fc`} className="agent-fc-list">
                {msg.fileChanges.map((fc) => (
                  <FileChangeCard key={fc.path} fc={fc} msgId={msg.id} openEditorFile={openEditorFile} onAccept={acceptFile} onReject={rejectFile} />
                ))}
              </div>
            )}
            {/* Todo list */}
            {msg.todos && msg.todos.length > 0 && <TodoCard key={`${msg.id}-todos`} todos={msg.todos} />}
            {msg.thought && (
              <details key={`${msg.id}-thought`} className="agent-thought" open={msg.state === "thinking"}>
                <summary className="agent-thought-summary">
                  <i className="codicon codicon-lightbulb" /> {msg.state === "thinking" ? "Thinking..." : "Thought process"}
                </summary>
                <div className="agent-thought-body">{msg.thought}</div>
              </details>
            )}
            {/* Tool execution card */}
            {msg.role === "tool" && msg.toolName && (
              <div key={`${msg.id}-tool`} className={`agent-tool-card${msg.state === "waiting" ? " streaming" : ""}`}>
                <div className="agent-tool-card-header">
                  {msg.state === "waiting" ? <span className="agent-spinner" /> : <i className="codicon codicon-check" />}
                  <i className={`codicon codicon-${msg.toolName.startsWith("browser_") ? "globe" : msg.toolName === "run_in_terminal" ? "terminal" : msg.toolName === "read_file" ? "file-code" : msg.toolName === "grep" ? "search" : msg.toolName === "list_files" || msg.toolName === "search_files" ? "folder-opened" : "tools"}`} />
                  <span className="agent-tool-card-name">{msg.toolName.replace("browser_", "").replace(/_/g, " ")}</span>
                  {msg.toolName === "run_in_terminal" && <span className="agent-tool-card-label">terminal</span>}
                  {msg.toolName === "run_command" && <span className="agent-tool-card-label">sandbox</span>}
                  {msg.toolParams && msg.toolName !== "run_in_terminal" && msg.toolName !== "run_command" && (
                    <span className="agent-tool-card-args">
                      {Object.entries(msg.toolParams).map(([k, v]) => (
                        <span key={k}>{k}: {String(v).slice(0, 60)}</span>
                      ))}
                    </span>
                  )}
                </div>
                {/* ── Terminal block for run_in_terminal ── */}
                {msg.toolName === "run_in_terminal" && (
                  <div className="agent-terminal">
                    <div className="agent-terminal-header">
                      <i className="codicon codicon-terminal" />
                      <span className="agent-terminal-cwd" title={projectPath}>{projectPath || "~"}</span>
                      {msg.permissionPrompt ? (
                        <i className="codicon codicon-warning agent-terminal-warn" />
                      ) : msg.state === "waiting" ? (
                        <span className="agent-spinner agent-terminal-spinner" />
                      ) : (
                        <i className="codicon codicon-check agent-terminal-done" />
                      )}
                    </div>
                    <div className="agent-terminal-cmdline">
                      <span className="agent-terminal-prompt">$</span>
                      <span className="agent-terminal-cmd">{String(msg.toolParams?.command ?? "")}</span>
                    </div>
                    {msg.sandboxOutput != null && (
                      <>
                        {!collapsedOutputs.has(msg.id) ? (
                          <pre
                            className="agent-terminal-out"
                            onClick={() => {
                              if (msg.state !== "waiting") {
                                setCollapsedOutputs((prev) => { const next = new Set(prev); next.add(msg.id); return next; });
                              }
                            }}
                          >{msg.sandboxOutput}</pre>
                        ) : (
                          <div
                            className="agent-terminal-out-collapsed"
                            onClick={() => setCollapsedOutputs((prev) => { const next = new Set(prev); next.delete(msg.id); return next; })}
                          >
                            <i className="codicon codicon-chevron-right" />
                            <span>Output ({msg.sandboxOutput.split("\n").length} lines)</span>
                          </div>
                        )}
                      </>
                    )}
                    {/* Permission prompt at the bottom of the terminal body */}
                    {msg.permissionPrompt && (
                      <div className="agent-terminal-perms">
                        <i className="codicon codicon-warning" />
                        <span>{msg.permissionPrompt}</span>
                        <div className="agent-perms-actions">
                          <button className="agent-btn agent-btn-accept" onClick={() => permissionResolveRef.current?.(true)}>Allow</button>
                          <button className="agent-btn agent-btn-reject" onClick={() => permissionResolveRef.current?.(false)}>Deny</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* ── Sandbox output for run_command and other tools ── */}
                {msg.toolName !== "run_in_terminal" && msg.sandboxOutput && (
                  <div className="agent-terminal">
                    <div className="agent-terminal-header">
                      <i className="codicon codicon-terminal" />
                      <span className="agent-terminal-cwd" title={projectPath}>{projectPath || "~"}</span>
                      <i className="codicon codicon-check agent-terminal-done" />
                    </div>
                    {msg.toolName === "run_command" && msg.toolParams && "command" in msg.toolParams && (
                      <div className="agent-terminal-cmdline">
                        <span className="agent-terminal-prompt">$</span>
                        <span className="agent-terminal-cmd">{String(msg.toolParams.command ?? "")}</span>
                      </div>
                    )}
                    <pre className="agent-terminal-out">{msg.sandboxOutput}</pre>
                  </div>
                )}
                {msg.content && !msg.sandboxOutput && msg.toolName !== "run_in_terminal" && (
                  <pre className="agent-code">{msg.content}</pre>
                )}
              </div>
            )}
            {/* Fallback for tool msgs without tool-card */}
            {msg.role === "tool" && !msg.toolName && msg.content && (
              <pre key={`${msg.id}-tool-fb`} className="agent-code">{msg.content}</pre>
            )}
            {msg.role !== "tool" && msg.content && (
              <div key={`${msg.id}-body`} className="agent-body">
                <span className="agent-role-icon"><i className={`codicon codicon-${iconForRole(msg.role)}`} /></span>
                <div className="agent-content">
                  <div className="agent-text">
                    {msg.role === "user" ? <CollapsedCode text={msg.content} msgId={msg.id} /> : msg.content}
                  </div>
                  {msg.role === "user" && (
                    <div className="agent-msg-actions">
                      <button className="agent-icon-btn" title="Copy" onClick={() => copyText(msg.content)}><i className="codicon codicon-copy" /></button>
                      <button className="agent-icon-btn" title="Delete" onClick={() => handleActionClick(() => removeMessage(msg.id))}><i className="codicon codicon-trash" /></button>
                      <button className="agent-icon-btn" title="Revert to before this message" onClick={() => handleActionClick(revertToPreRound)}><i className="codicon codicon-discard" /></button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {loading && !messages[messages.length - 1]?.state && (
          <div className="agent-msg agent-msg-system">
            <div className="agent-state"><span className="agent-spinner" /> Thinking...</div>
          </div>
        )}
        {/* ── Completion footer ── */}
        {!loading && (agentStatus === "completed" || agentStatus === "stopped") && (
          <div className="agent-footer">
            <div className="agent-footer-status">
              {agentStatus === "completed" ? (
                <><i className="codicon codicon-check-all" /> Completed</>
              ) : agentStatus === "stopped" ? (
                <><i className="codicon codicon-debug-stop" /> Manually Stopped</>
              ) : (
                <><i className="codicon codicon-comment-discussion" /> Conversation</>
              )}
            </div>
            {agentUsage && (
              <div className="agent-footer-usage">
                <div className="agent-footer-usage-bar">
                  <div
                    className={`agent-footer-usage-fill${agentUsage.estimatedTokens > agentUsage.contextLimit * 0.8 ? " high" : ""}`}
                    style={{ width: `${Math.min(100, (agentUsage.estimatedTokens / agentUsage.contextLimit) * 100)}%` }}
                  />
                </div>
                <span className="agent-footer-usage-text">
                  ~{agentUsage.estimatedTokens} / {agentUsage.contextLimit} tokens ({Math.round((agentUsage.estimatedTokens / agentUsage.contextLimit) * 100)}%) &middot; {agentUsage.turns} turns
                </span>
              </div>
            )}
            <div className="agent-footer-actions">
              {changedFiles.length > 0 && (
                <div className="agent-diff-host">
                  <button className="agent-footer-btn" title="View changes" onClick={() => setDiffPanelOpen((v) => !v)}>
                    <i className="codicon codicon-diff" /> {changedFiles.length} diff{changedFiles.length > 1 ? "s" : ""}
                  </button>
                  {diffPanelOpen && (
                    <div className="agent-diff-panel">
                      <div className="agent-diff-panel-header">Changed files</div>
                      {changedFiles.map((f) => (
                        <div key={f.path} className={`agent-diff-file${expandedDiffPath === f.path ? " expanded" : ""}`}>
                          <button className="agent-diff-file-name" onClick={() => setExpandedDiffPath((p) => p === f.path ? null : f.path)}>
                            <i className={`codicon codicon-${expandedDiffPath === f.path ? "chevron-down" : "chevron-right"}`} />
                            <span>{f.name}</span>
                            <span className="agent-diff-file-path">{f.path}</span>
                          </button>
                          {expandedDiffPath === f.path && (
                            <div className="agent-diff-content">
                              {f.diff.split("\n").map((line, i) => (
                                <span key={i} className={`agent-diff-line${line.startsWith("+") ? " added" : line.startsWith("-") ? " removed" : ""}`}>{line}{"\n"}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button className={`agent-footer-btn${thumbsFeedback === "up" ? " active" : ""}`} title="Good response" onClick={() => feedback("up")}>
                <i className={`codicon codicon-${thumbsFeedback === "up" ? "thumbsup-filled" : "thumbsup"}`} />
              </button>
              <button className={`agent-footer-btn${thumbsFeedback === "down" ? " active" : ""}`} title="Bad response" onClick={() => feedback("down")}>
                <i className={`codicon codicon-${thumbsFeedback === "down" ? "thumbsdown-filled" : "thumbsdown"}`} />
              </button>
              <button className="agent-footer-btn" title="Copy entire chat" onClick={copyChat}>
                <i className="codicon codicon-copy" />
              </button>
              <button className="agent-footer-btn" title="Retry last prompt" onClick={retryLast}>
                <i className="codicon codicon-refresh" />
              </button>
              <button className="agent-footer-btn" title="Create a copy of this chat" onClick={forkChat}>
                <i className="codicon codicon-repo-forked" />
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Pending todos / changes banner ── */}
      {(pendingTodos.length > 0 || unconfirmedFileChanges.length > 1) && (
        <div className="agent-pending-banner">
          {pendingTodos.length > 0 && (
            <details className="agent-pending-todos" open={showPendingBanner} onToggle={(e) => setShowPendingBanner((e.target as HTMLDetailsElement).open)}>
              <summary className="agent-pending-summary">
                <i className="codicon codicon-checklist" /> {pendingTodos.length} pending task{pendingTodos.length > 1 ? "s" : ""}
              </summary>
              <div className="agent-pending-list">
                {pendingTodos.map((t) => (
                  <div key={t.id} className={`agent-todo-item ${t.status}`}>
                    <i className={`codicon codicon-${t.status === "in_progress" ? "loading" : "circle-outline"}`} />
                    <span className="agent-todo-text">{t.text}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {unconfirmedFileChanges.length > 1 && (
            <button className="agent-pending-accept-all" onClick={acceptAllChanges}>
              <i className="codicon codicon-check-all" /> Accept all ({unconfirmedFileChanges.length} changes)
            </button>
          )}
        </div>
      )}

      {/* ── Input area (textarea + overlaid buttons) ── */}
      <div className="agent-input-area">
        {mentionOpen && (
          <div className="agent-mention-dropdown">
            {fileLoading && filteredFiles.length === 0 ? (
              <div className="agent-mention-hint"><span className="agent-spinner" /> Loading files...</div>
            ) : filteredFiles.length > 0 ? (
              filteredFiles.map((f, i) => (
                <button
                  key={f.full}
                  className={`agent-mention-item${i === mentionIndex ? " active" : ""}`}
                  onMouseDown={(e) => { e.preventDefault(); insertMention(f.full); }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  <i className="codicon codicon-file" />
                  <span className="agent-mention-name">{f.name}</span>
                  <span className="agent-mention-path">{f.display}</span>
                </button>
              ))
            ) : (
              <div className="agent-mention-hint">No project files found. Open a folder or refresh.</div>
            )}
          </div>
        )}
        <div className="agent-input-row">
          <textarea
            ref={inputRef}
            className="agent-textarea"
            value={input}
            onChange={(e) => { setInput(e.target.value); setMentionIndex(0); }}
            onKeyDown={(e) => {
              if (mentionOpen) {
                if (e.key === "ArrowDown" && filteredFiles.length > 0) { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, filteredFiles.length - 1)); return; }
                if (e.key === "ArrowUp" && filteredFiles.length > 0) { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  if (filteredFiles[mentionIndex]) { insertMention(filteredFiles[mentionIndex].full); }
                  return;
                }
                // Space or Shift+Enter: let the char through — query will have a space, mentionQuery returns "", dropdown closes naturally.
                if (e.key === " " || (e.key === "Enter" && e.shiftKey)) { closeMention(); return; }
                if (e.key === "Escape") { e.preventDefault(); closeMention(); return; }
              }
              if (e.key === "Enter" && !e.shiftKey && !mentionOpen) { e.preventDefault(); send(); }
            }}
            placeholder={apiKey ? "Ask the agent...  (Shift+Enter for new line)" : "Set an API key to start chatting..."}
            disabled={loading || !apiKey}
            rows={3}
          />
          <div className="agent-input-buttons">
            <button className="agent-context-btn" title="Mention a file" onClick={insertHash}>#</button>
            {loading ? (
              <button className="agent-send-btn agent-stop-btn" onClick={stop} title="Stop"><i className="codicon codicon-debug-stop" /></button>
            ) : (
              <button className="agent-send-btn" onClick={send} disabled={!input.trim()} title="Send"><i className="codicon codicon-send" /></button>
            )}
          </div>
        </div>
        {/* ── Model selector ── */}
        <div className="agent-model-bar">
          <div className="agent-model-selector" ref={modelPickerRef}>
            <button className="agent-model-btn" onClick={() => setModelPickerOpen((v) => !v)} title="Configure model">
              {!apiKey ? (
                <>
                  <i className="codicon codicon-warning" style={{color: "#d29922"}} />
                  <span style={{color: "#d29922"}}>Set API Key</span>
                </>
              ) : (
                <>
                  <i className="codicon codicon-symbol-method" />
                  <span>{selectedModel || "deepseek-chat"}</span>
                  <span className="agent-model-mode-badge">{isThinking ? "Thinking" : "Chat"}</span>
                </>
              )}
              <i className={`codicon codicon-chevron-${modelPickerOpen ? "down" : "up"}`} />
            </button>
            {modelPickerOpen && (
              <div className="agent-model-popup">
                <div className="agent-model-popup-title">Saved Configurations</div>
                {/* Preset list */}
                {presets.length > 0 ? (
                  presets.map((p) => (
                    <div key={p.id} className={`agent-model-preset-row${activePresetId === p.id ? " active" : ""}`}>
                      <button
                        className="agent-model-item agent-model-preset-btn"
                        onClick={() => selectPreset(p.id)}
                      >
                        <span className="agent-model-item-name">{p.model}</span>
                        <span className="agent-model-mode-badge">{p.thinking ? "Think" : "Chat"}</span>
                      </button>
                      <span className="agent-model-preset-icons">
                        <button className="agent-model-preset-icon-btn" onClick={() => { selectPreset(p.id); setEditModelInput(p.model); setIsThinking(p.thinking); }} title="Modify">
                          <i className="codicon codicon-edit" />
                        </button>
                        <button className="agent-model-preset-icon-btn agent-model-preset-icon-del" onClick={() => deletePreset(p.id)} title="Delete">
                          <i className="codicon codicon-trash" />
                        </button>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="agent-mention-hint">No saved configs. Fill in below and Save.</div>
                )}
                <div className="agent-model-popup-divider" />
                <div className="agent-model-popup-title">Edit</div>
                {/* Model name input */}
                <div className="agent-model-name-edit">
                  <label className="agent-model-label">Model</label>
                  <input
                    className="agent-model-apikey-input"
                    type="text"
                    placeholder="deepseek-chat"
                    value={editModelInput}
                    onChange={(e) => { setEditModelInput(e.target.value); }}
                  />
                </div>
                {/* Thinking / Non-thinking toggle */}
                <button className="agent-model-item" onClick={toggleThinking}>
                  <span className="agent-model-item-name">Mode</span>
                  <span className="agent-model-item-desc">{isThinking ? "Thinking (reasoning)" : "Non-thinking (chat)"}</span>
                  <i className={`codicon codicon-${isThinking ? "check" : "circle-outline"}`} style={{color: isThinking ? "#4ec94e" : undefined}} />
                </button>
                {/* API Key */}
                {editingApiKey ? (
                  <div className="agent-model-apikey-edit">
                    <input
                      className="agent-model-apikey-input"
                      type="password"
                      placeholder="sk-..."
                      value={tempApiKey}
                      onChange={(e) => setTempApiKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { setApiKey(tempApiKey); localStorage.setItem("harness-api-key", tempApiKey); setEditingApiKey(false); } }}
                      autoFocus
                    />
                    <button className="agent-model-apikey-save" onClick={() => { setApiKey(tempApiKey); localStorage.setItem("harness-api-key", tempApiKey); setEditingApiKey(false); }}>Save</button>
                    <button className="agent-model-apikey-cancel" onClick={() => setEditingApiKey(false)}>Cancel</button>
                  </div>
                ) : apiKey ? (
                  <>
                    <div className="agent-model-apikey-display">
                      <i className="codicon codicon-key" />
                      <span>{maskApiKey(apiKey)}</span>
                    </div>
                    <div className="agent-model-apikey-row">
                      <button className="agent-model-item" onClick={() => { setTempApiKey(""); setEditingApiKey(true); }}>
                        <span className="agent-model-item-name">Replace API Key</span>
                        <i className="codicon codicon-refresh" />
                      </button>
                      <button className="agent-model-item agent-model-item-danger" onClick={() => { setApiKey(""); localStorage.setItem("harness-api-key", ""); }}>
                        <span className="agent-model-item-name">Delete</span>
                        <i className="codicon codicon-trash" />
                      </button>
                    </div>
                  </>
                ) : (
                  <button className="agent-model-item" onClick={() => { setTempApiKey(""); setEditingApiKey(true); }}>
                    <span className="agent-model-item-name">Add API Key</span>
                    <span className="agent-model-item-desc">Required to use DeepSeek</span>
                    <i className="codicon codicon-add" />
                  </button>
                )}
                <div className="agent-model-popup-divider" />
                {/* Save / Clear buttons */}
                <div className="agent-model-preset-save-row">
                  <button className="agent-model-apikey-save" onClick={saveAsPreset} style={{background: "#4ec94e"}}>
                    <i className="codicon codicon-save" /> {activePreset ? "Update" : "Save"}
                  </button>
                  {activePreset && (
                    <button className="agent-model-apikey-save" onClick={savePresetAsNew}>
                      <i className="codicon codicon-diff-added" /> Save as New
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
