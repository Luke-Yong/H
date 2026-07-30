import { useRef, useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { AgentTerminalBridge } from "./AgentTerminalBridge";

// ── Rich message types for the unified agent chat ──

interface ConsoleMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  when: number;
  toolCallId?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  thought?: string;
  state?: "thinking" | "generating" | "waiting" | "file_viewing";
  viewingFile?: string;
  pendingDiff?: { path: string; content: string };
  permissionPrompt?: string;
  sandboxOutput?: string;
  /** Original file content captured before a destructive tool runs (for undo/Monaco diff). */
  destructiveOriginal?: string;
  /** Token count for file tools (copied from file-change card). */
  tokenCount?: number;
  /** Structured todo list (rendered as a checklist card in the console). */
  todos?: TodoItem[];
  /** Pending file change operations with diff stats (rendered as file-change cards). */
  fileChanges?: FileChange[];
  /** True if this system message is a warning (amber accent). */
  isWarning?: boolean;
  /** Sub-agent message trace (rendered as collapsible block). */
  subAgentMessages?: { role: string; content: string; name?: string; reasoning_content?: string }[];
  /** Sub-agent display name. */
  subAgentName?: string;
  /** Agent marker for color coding: "main", "browser", "code-search", "code-writer", "researcher". */
  agentMarker?: string;
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
  /** Whether this change requires user Accept/Reject (only edit_file). */
  deferred?: boolean;
}

interface ChatThread {
  id: string;
  sessionId?: string;
  title: string;
  messages: ConsoleMessage[];
  createdAt: number;
  usage?: UsageStats;
}

interface UsageStats {
  estimatedTokens: number;
  contextLimit: number;
  turns: number;
  requestCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
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
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t: any) => ({
      ...t,
      sessionId: typeof t?.sessionId === "string" && t.sessionId ? t.sessionId : String(t?.id || ""),
      messages: Array.isArray(t?.messages) ? t.messages : [],
    }));
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
function getStoredThinking(): boolean {
  try { return localStorage.getItem("harness-thinking") === "true"; } catch { return false; }
}

// ── Props ──
interface Props {
  goal: string;
  onGoalChange: (value: string) => void;
  getConsoleContext?: () => string;
  /** Pre-fetch file tree context before each agent run (called by parent via EditorPane). */
  refreshFileTreeContext?: () => Promise<void>;
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
  /** Close a file tab in the editor (e.g. after deleting it). */
  closeEditorFile?: (fsPath: string) => void;
  /** Rename a file tab in the editor (e.g. after agent renames a file). */
  renameEditorFile?: (oldPath: string, newPath: string) => void;
  /** Agent ↔ terminal bridge — when agent runs a command it spawns in a real terminal */
  agentTerminalBridge?: AgentTerminalBridge;
}

// ── Component ──

export default function AgentConsole({ goal, onGoalChange, getConsoleContext, refreshFileTreeContext, executeBrowserAction, getProjectFiles, getFsBasePath, refreshEditor, applyAgentFileChanges, onRefreshFs, setAgentFileActionRef, openEditorFile, acceptEditorChange, rejectEditorChange, closeEditorFile, renameEditorFile, agentTerminalBridge }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const consoleListRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ConsoleMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const preRoundRef = useRef<ConsoleMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const actionClickLockRef = useRef(0);
  const permissionResolveRef = useRef<((granted: boolean) => void) | null>(null);
  const pendingPermissionMsgIdRef = useRef<string | null>(null);
  const queuedPermissionDecisionRef = useRef<boolean | null>(null);
  const agentDoneRef = useRef(false);
  // Cumulative turns across the entire session (not per-response)
  const totalTurnsRef = useRef(0);
  // Track which sub-agent cards are expanded (keyed by message id)
  const [expandedSubAgents, setExpandedSubAgents] = useState<Set<string>>(new Set());
  // Agent completion footer state
  const [agentStatus, setAgentStatus] = useState<"idle" | "completed" | "stopped">("idle");
  const [agentUsage, setAgentUsage] = useState<UsageStats | null>(null);
  // Track which terminal outputs are collapsed (keyed by message id)
  const [collapsedOutputs, setCollapsedOutputs] = useState<Set<string>>(new Set());
  // Track agent terminal output streaming from the bridge
  const agentTermMsgIdRef = useRef<string | null>(null);
  const agentTermOutputRef = useRef<string>("");
  // Track the local message ID of the most recent delegate_task tool card
  const delegateTaskCardIdRef = useRef<string | null>(null);
  const toolCallMsgIdRef = useRef<Map<string, string>>(new Map());
  const activeDelegationMarkerRef = useRef<string | null>(null);
  const activeDelegationDepthRef = useRef(0);
  // Deferred destructive file tool: after file auto-executes, diff is shown. User must Accept/Reject before agent continues.
  const deferredToolRef = useRef<{ sessionId: string; toolCallId: string; filePath: string; name: string; originalContent: string | null } | null>(null);
  const continueDeferredRef = useRef<((accepted: boolean, sessionId: string, toolCallId: string) => Promise<void>) | null>(null);
  // Cache token counts from file-changes so tool cards can read them after fileChangesRef is cleared
  const fcTokenByPathRef = useRef<Map<string, number>>(new Map());
  const selectedModelRef = useRef<string>("");
  const isThinkingRef = useRef(false);
  const editingModelRef = useRef(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeySource, setApiKeySource] = useState<"session" | "server" | "none">("none");
  const [configChecked, setConfigChecked] = useState(false);

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
        // Ref is NOT cleared here — the permission wait loop reads it, then clears it.
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

  // Model/thinking from active preset or manual entry
  const [selectedModel, setSelectedModel] = useState<string>(() => activePreset?.model || getStoredModel());
  const [isThinking, setIsThinking] = useState<boolean>(() => activePreset?.thinking ?? getStoredThinking());

  // Keep refs in sync for deferred file tool callbacks
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { isThinkingRef.current = isThinking; }, [isThinking]);

  // Sync model/thinking from activePreset when it changes
  useEffect(() => {
    if (activePreset) {
      setSelectedModel(activePreset.model);
      setIsThinking(activePreset.thinking);
    }
  }, [activePreset]);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [editingModel, setEditingModel] = useState(false);
  useEffect(() => { editingModelRef.current = editingModel; }, [editingModel]);
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [tempApiKey, setTempApiKey] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [editModelInput, setEditModelInput] = useState(selectedModel);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const refreshAgentConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/agent/config");
      const data = await res.json();
      setApiKeyConfigured(Boolean(data?.apiKeyConfigured));
      setApiKeySource(data?.source === "session" ? data.source : "none");
    } catch {
      setApiKeyConfigured(false);
      setApiKeySource("none");
    } finally {
      setConfigChecked(true);
    }
  }, []);

  useEffect(() => {
    try { localStorage.removeItem("harness-api-key"); } catch {}
    void refreshAgentConfig();
  }, [refreshAgentConfig]);

  const saveApiKey = useCallback(async () => {
    const apiKey = tempApiKey.trim();
    if (!apiKey) return;
    setSavingApiKey(true);
    try {
      const res = await fetch("/api/chat/agent/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      setEditingApiKey(false);
      setTempApiKey("");
      await refreshAgentConfig();
    } catch (err) {
      setMessages((prev) => [...prev, { id: nextId(), role: "system", content: `Error saving API key: ${String(err)}`, when: Date.now() }]);
    } finally {
      setSavingApiKey(false);
    }
  }, [tempApiKey, refreshAgentConfig]);

  const clearApiKey = useCallback(async () => {
    setSavingApiKey(true);
    try {
      const res = await fetch("/api/chat/agent/credentials", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      setEditingApiKey(false);
      setTempApiKey("");
      await refreshAgentConfig();
    } catch (err) {
      setMessages((prev) => [...prev, { id: nextId(), role: "system", content: `Error clearing API key: ${String(err)}`, when: Date.now() }]);
    } finally {
      setSavingApiKey(false);
    }
  }, [refreshAgentConfig]);

  // Save/update a preset — dedup by model id
  const saveAsPreset = useCallback(() => {
    const model = editModelInput.trim();
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
    const model = editModelInput.trim();
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
      setEditModelInput(p.model);
    }
    if (!editingModelRef.current) setModelPickerOpen(false);
  }, [presets]);

  const toggleThinking = useCallback(() => {
    setIsThinking((v) => { const n = !v; localStorage.setItem("harness-thinking", String(n)); return n; });
  }, []);

  const saveModelAndClose = useCallback(() => {
    const id = editModelInput.trim();
    setSelectedModel(id);
    localStorage.setItem("harness-model", id);
    setModelPickerOpen(false);
  }, [editModelInput]);

  useEffect(() => {
    setEditModelInput(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
        setEditingModel(false);
        setEditingApiKey(false);
      }
    };
    if (modelPickerOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [modelPickerOpen]);

  // ── Editor ↔ Console sync for file accept/reject ──
  // Resolve a potentially relative file path to absolute using the project root.
  const resolvePath = useCallback((p: string): string => {
    const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
    if (root && !/^[a-zA-Z]:/.test(p) && !p.startsWith("/")) {
      return root + "/" + p.replace(/\\/g, "/");
    }
    return p;
  }, [getFsBasePath]);

  const handlePermissionResponse = useCallback((msgId: string, granted: boolean) => {
    const activeMsgId = pendingPermissionMsgIdRef.current;
    if (activeMsgId && activeMsgId !== msgId) return;
    queuedPermissionDecisionRef.current = granted;
    const resolve = permissionResolveRef.current;
    if (resolve) {
      permissionResolveRef.current = null;
      pendingPermissionMsgIdRef.current = null;
      const decision = queuedPermissionDecisionRef.current ?? granted;
      queuedPermissionDecisionRef.current = null;
      resolve(decision);
    }
  }, []);

  const handleBannerFileAction = useCallback((fcPath: string, accepted: boolean) => {
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    // Match fcPath (absolute from Monaco) against fc.path (relative from agent tool calls)
    const matches = (fcPathAbs: string, fcPathRel: string) => {
      const a = norm(fcPathAbs);
      const b = norm(fcPathRel);
      return a === b || a.endsWith("/" + b);
    };
    // Capture rename paths while updating the file-change status
    let renameOldPath = "";
    let renameNewPath = "";
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (!m.fileChanges) return m;
        const updated = m.fileChanges.map((fc) => {
          if (matches(fcPath, fc.path) && !fc.accepted && !fc.rejected) {
            changed = true;
            if (fc.changeType === "rename" && fc.content) {
              renameOldPath = fc.path;
              renameNewPath = fc.content;
            }
            return { ...fc, accepted, rejected: !accepted };
          }
          return fc;
        });
        return changed ? { ...m, fileChanges: updated } : m;
      });
      return changed ? next : prev;
    });
    // If this is a deferred file tool, resume the agent stream
    const dt = deferredToolRef.current;
    if (dt) {
      const nDtPath = norm(dt.filePath);
      const nFcPath = norm(fcPath);
      if (nFcPath === nDtPath || nFcPath.endsWith("/" + dt.name) || nFcPath.endsWith("\\" + dt.name)) {
        const absDtPath = resolvePath(dt.filePath);
        if (accepted) {
          acceptEditorChange?.(absDtPath);
        } else {
          rejectEditorChange?.(absDtPath);
        }
        onRefreshFs?.();
        // Update editor tab on rename accept (tab still shows old name)
        if (accepted && renameOldPath && renameNewPath) {
          renameEditorFile?.(resolvePath(renameOldPath), resolvePath(renameNewPath));
        }
        setLoading(true);
        deferredToolRef.current = null;
        continueDeferredRef.current?.(accepted, dt.sessionId, dt.toolCallId);
      }
    } else {
      if (accepted) {
        acceptEditorChange?.(fcPath);
      } else {
        rejectEditorChange?.(fcPath);
      }
      onRefreshFs?.();
    }
  }, [getFsBasePath, acceptEditorChange, rejectEditorChange, onRefreshFs, resolvePath, renameEditorFile]);

  useEffect(() => {
    setAgentFileActionRef?.(handleBannerFileAction);
  }, [setAgentFileActionRef, handleBannerFileAction]);

  // ── Thread management ──
  // Derive project path once at mount / on change. Threads are scoped to this path.
  const projectPath = getFsBasePath?.() || "";
  const threadKey = useMemo(() => storageKey(projectPath), [projectPath]);
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads(threadKey));
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  // Effective usage: prefer state, fall back to persisted thread usage
  const effectiveUsage = useMemo(() => {
    if (agentUsage) return agentUsage;
    const t = threads.find((t) => t.id === activeThreadId);
    return t?.usage ?? null;
  }, [agentUsage, threads, activeThreadId]);
  const [showHistory, setShowHistory] = useState(false);
  const historyPanelRef = useRef<HTMLDivElement>(null);

  // Close history panel on outside click
  useEffect(() => {
    if (!showHistory) return;
    const handle = (e: MouseEvent) => {
      if (historyPanelRef.current && !historyPanelRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showHistory]);

  const [fileList, setFileList] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);

  // Reload threads when project path changes — auto‑select the latest chat.
  useEffect(() => {
    const loaded = loadThreads(threadKey);
    setThreads(loaded);
    if (loaded.length > 0) {
      // Pick the most recent thread by createdAt
      const latest = loaded.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      setActiveThreadId(latest.id);
      setMessages(latest.messages);
      syncMid(latest.messages);
      // Loaded saved chats are no longer streaming — show the footer.
      setAgentStatus("completed");
      setAgentUsage(latest.usage ?? null);
      setLoading(false);
    } else {
      setActiveThreadId("");
      setMessages([]);
      setAgentStatus("idle");
      setAgentUsage(null);
    }
    preRoundRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  // Stable ref for getProjectFiles to avoid re-running the file-list effect
  // when the parent passes a new function reference on every render.
  const getProjectFilesRef = useRef(getProjectFiles);
  getProjectFilesRef.current = getProjectFiles;

  // Load project files async for mention dropdown
  useEffect(() => {
    let active = true;
    setFileLoading(true);
    (async () => {
      const files = await (getProjectFilesRef.current?.() ?? Promise.resolve([]));
      if (active) { setFileList(files); setFileLoading(false); }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]); // reload on messages change (files may be created)

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
    const t: ChatThread = { id, sessionId: id, title: `Chat ${threads.length + 1}`, messages: [], createdAt: Date.now() };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setMessages([]);
    setAgentStatus("idle");
    setAgentUsage(null);
    return id;
  }, [activeThreadId, threads]);

  const newTask = useCallback(() => {
    const id = `thread-${Date.now()}`;
    const t: ChatThread = { id, sessionId: id, title: `Chat ${threads.length + 1}`, messages: [], createdAt: Date.now() };
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
      syncMid(t.messages);
      preRoundRef.current = [];
      // Loaded saved chats are no longer streaming — show the footer.
      setAgentStatus("completed");
      setAgentUsage(t.usage ?? null);
      setLoading(false);
    }
    setShowHistory(false);
  }, [threads]);

  const deleteThread = useCallback((id: string) => {
    const sid = threads.find((t) => t.id === id)?.sessionId || id;
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
    fetch(`/api/chat/agent/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" }).catch(() => {});
  }, [activeThreadId, threadKey, threads]);

  // Update thread title from first user message — use first sentence as concise summary
  const updateThreadTitle = useCallback((threadId: string, content: string) => {
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === threadId);
      if (idx === -1) return prev;
      // Only update if title still has the default "Chat N" pattern
      if (!/^Chat \d+$/.test(prev[idx].title)) return prev;
      // Extract first sentence (split on . ! ? or newline), or truncate to 40 chars
      const firstSentence = content.split(/[.!?\n]/)[0].trim();
      const title = firstSentence.length > 4
        ? (firstSentence.length > 40 ? firstSentence.slice(0, 40) + "..." : firstSentence)
        : (content.length > 40 ? content.slice(0, 40) + "..." : content);
      const next = [...prev];
      next[idx] = { ...next[idx], title };
      return next;
    });
  }, []);

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

  // Auto-scroll to bottom only when user is already near the bottom.
  // If they've scrolled up to read history, don't yank them back.
  useEffect(() => {
    const el = consoleListRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || !userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Track manual scroll — if user scrolls up, stop auto-scrolling.
  useEffect(() => {
    const el = consoleListRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      userScrolledUpRef.current = !nearBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll open agent-thought-body elements to bottom as content streams in.
  useEffect(() => {
    const bodies = document.querySelectorAll("details.agent-thought[open] .agent-thought-body");
    for (const body of bodies) {
      (body as HTMLElement).scrollTop = (body as HTMLElement).scrollHeight;
    }
  }, [messages]);

  // Safety: if loading is stuck for 5 min with no new messages, force it off.
  // Sub-agents (especially browser with 100 iterations) can run for minutes.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => { setLoading(false); setAgentStatus("stopped"); }, 300_000);
    return () => clearTimeout(timer);
  }, [loading, messages.length]);

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

  const revertToPreRound = useCallback((msgId: string) => {
    const msgIndex = messages.findIndex((m) => m.id === msgId);
    if (msgIndex < 0) return;
    const removed = messages.slice(msgIndex);
    const kept = messages.slice(0, msgIndex);
    // Revert file changes on disk for all messages being removed
    const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
    for (const m of removed) {
      if (!m.fileChanges) continue;
      for (const fc of m.fileChanges) {
        if (fc.accepted || fc.rejected || !fc.path) continue;
        let resolved = fc.path;
        if (root && !/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith("/")) {
          resolved = root + "/" + resolved.replace(/\\/g, "/");
        }
        const hasOriginal = fc.originalContent != null;
        (async () => {
          try {
            if (fc.changeType === "rename" && fc.content) {
              let newResolved = fc.content;
              if (root && !/^[a-zA-Z]:/.test(newResolved) && !newResolved.startsWith("/")) {
                newResolved = root + "/" + newResolved.replace(/\\/g, "/");
              }
              const res = await fetch("/api/fs/rename", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ oldPath: newResolved, newPath: resolved }),
              });
              if (!res.ok) throw new Error(`Rename revert HTTP ${res.status}`);
              renameEditorFile?.(resolvePath(newResolved), resolvePath(fc.path));
            } else if (hasOriginal) {
              const res = await fetch("/api/fs/write", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: resolved, content: fc.originalContent }),
              });
              if (!res.ok) throw new Error(`Write revert HTTP ${res.status}`);
            } else {
              const res = await fetch("/api/fs/delete", {
                method: "DELETE", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: resolved }),
              });
              if (!res.ok) throw new Error(`Delete revert HTTP ${res.status}`);
              closeEditorFile?.(resolvePath(fc.path));
            }
            rejectEditorChange?.(resolvePath(fc.path));
            onRefreshFs?.();
          } catch (err) {
            console.error("Revert file change failed:", err);
          }
        })();
      }
    }
    setMessages(kept);
    preRoundRef.current = kept;
  }, [messages, getFsBasePath, resolvePath, rejectEditorChange, onRefreshFs, closeEditorFile, renameEditorFile]);

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
  const streamToolRef = useRef<Map<string, { name: string; params: Record<string, unknown>; agentMarker?: string }>>(new Map());
  const writeSummaryRef = useRef<Map<string, { summary: string; isSubAgent: boolean; agentMarker?: string }>>(new Map());
  const lastRenderedSummaryRef = useRef<string>("");
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

  const runAgent = useCallback(async (threadId: string, userMessage: string, signal: AbortSignal) => {
    // Pre-fetch latest file tree context (full on first call, patch on subsequent)
    await refreshFileTreeContext?.();
    const consoleSnapshot = getConsoleContext?.() || "";
    // Append current terminal output if available (from running run_in_terminal commands)
    const termOut = agentTermOutputRef.current || "";
    const fullContext = termOut
      ? `${consoleSnapshot}\n### Terminal Output ###\n${termOut.slice(-2000)}`
      : consoleSnapshot;
    const root = getFsBasePath?.() || "";
    agentDoneRef.current = false;
    streamToolRef.current = new Map();
    toolCallMsgIdRef.current = new Map();
    fileChangesRef.current = [];
    pendingFileChangesRef.current = [];
    todosRef.current = [];
    fcTokenByPathRef.current = new Map();
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
    const knownSid = threads.find((t) => t.id === threadId)?.sessionId || threadId;
    let sessionId = knownSid;
    let toolCallId = "";
    let isPermission = false;
    let agentDone = false;
    let currentThought = "";
    let currentText = "";
    let assistantMsgId: string | null = null;
    const toolIds: string[] = []; // track tool messages within this round

    try {
      await consumeSSE("/api/chat/agent/stream", { sessionId, message: userMessage, context: fullContext, projectRoot: root, model: selectedModel }, async (evt) => {
        if (signal.aborted) return false;
        if (evt.sessionId && evt.sessionId !== sessionId) {
          sessionId = evt.sessionId;
          setThreads((prev) => {
            const idx = prev.findIndex((t) => t.id === threadId);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], sessionId };
            return next;
          });
        }

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
            // Token cost = only the changed strings sent to the API, not the whole file
            const tokenCount = Math.round((oldStr.length + newStr.length) / 4);
            fileChangesRef.current.push({
              path: p, name, content, changeType: "write",
              status: "streaming",
              tokenCount,
              originalContent: orig ?? null,
              deferred: true,
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
          // Capture the last file-change token count before the assistant flush clears the ref
          const lastFcBeforeFlush = fileChangesRef.current[fileChangesRef.current.length - 1];
          const fcTokenSaved = lastFcBeforeFlush?.tokenCount;
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
          const toolNameStr = String(evt.toolName || "");
          if (toolNameStr === "task_complete") {
            return true;
          }
          if (toolNameStr === "write_summary") {
            const writeSummaryKey = String(evt.toolCallId || "__latest__");
            writeSummaryRef.current.set(writeSummaryKey, {
              summary: String(evt.toolParams?.summary || ""),
              isSubAgent: !!(evt as any).isSubAgent,
              agentMarker: (evt as any).agentMarker || activeDelegationMarkerRef.current || ((evt as any).isSubAgent ? "code-writer" : "main"),
            });
            return true;
          }
          const id = nextId();
          toolIds.push(id);
          const isSubAgent = !!(evt as any).isSubAgent;
          const marker = (evt as any).agentMarker || activeDelegationMarkerRef.current || (isSubAgent ? "code-writer" : "main");
          streamToolRef.current.set(id, { name: evt.toolName, params: evt.toolParams || {}, agentMarker: marker });
          // Create the card immediately — command line will be visible right away.
          // Open file in Monaco for file tools (close tab for delete to release handle)
          const FILE_EDIT_TOOLS = ["write_file", "edit_file", "delete_file", "rename_file"];
          if (FILE_EDIT_TOOLS.includes(evt.toolName) && (evt.toolParams?.path || evt.toolParams?.oldPath)) {
            const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
            let p = String(evt.toolParams.path || evt.toolParams.oldPath || "");
            if (root && !/^[a-zA-Z]:/.test(p) && !p.startsWith("/")) {
              p = root + "/" + p.replace(/\\/g, "/");
            }
            if (evt.toolName === "delete_file") {
              closeEditorFile?.(p);
            } else {
              openEditorFile?.(p);
            }
          }
          flushSync(() => {
            pushRaw(id, {
              role: "tool", content: "", toolName: evt.toolName, toolParams: evt.toolParams, toolCallId: evt.toolCallId,
              state: "waiting",
              sandboxOutput: evt.toolName === "run_command" ? "" : undefined,
              tokenCount: fcTokenSaved as number | undefined,
              agentMarker: marker,
              ...(isSubAgent ? { subAgentName: "Sub-agent" } : {}),
            });
            if (evt.toolCallId) toolCallMsgIdRef.current.set(evt.toolCallId, id);
            if (evt.toolName === "delegate_task") {
              delegateTaskCardIdRef.current = id;
              activeDelegationDepthRef.current += 1;
              activeDelegationMarkerRef.current = marker;
            }
            });
        } else if (evt.type === "tool_end") {
          // Switch file changes from streaming to done and auto-apply to editor.
          const tn = evt.toolName;
          if (tn === "task_complete") {
            const tr = String(evt.toolResult || "");
            if (tr && tr !== "OK") {
              pushRaw(nextId(), { role: "system", content: tr });
            }
            return true;
          }
          if (tn === "write_summary") {
            const tr = String(evt.toolResult || "");
            const writeSummaryKey = String(evt.toolCallId || "__latest__");
            const storedSummary = writeSummaryRef.current.get(writeSummaryKey);
            writeSummaryRef.current.delete(writeSummaryKey);
            const looksLikeSummary = /###\s*Changes\s*Made/i.test(tr) && /###\s*Verification/i.test(tr) && /###\s*Outcome/i.test(tr);
            if (looksLikeSummary) {
              const summaryText = (storedSummary?.summary || tr).trim();
              if (summaryText && !storedSummary?.isSubAgent) {
                lastRenderedSummaryRef.current = summaryText.replace(/\r\n/g, "\n");
                pushRaw(nextId(), {
                  role: "assistant",
                  content: summaryText,
                  agentMarker: storedSummary?.agentMarker || "main",
                });
              }
            } else {
              const id = nextId();
              toolIds.push(id);
              pushRaw(id, { role: "tool", toolName: tn, content: tr, state: undefined });
            }
            return true;
          }
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
            if (tn === "rename_file") {
              const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
              let oldP = String(evt.toolParams?.oldPath || "");
              let newP = String(evt.toolParams?.newPath || "");
              if (root && oldP && newP) {
                if (!/^[a-zA-Z]:/.test(oldP) && !oldP.startsWith("/")) oldP = root + "/" + oldP;
                if (!/^[a-zA-Z]:/.test(newP) && !newP.startsWith("/")) newP = root + "/" + newP;
                renameEditorFile?.(oldP, newP);
              }
            }
          }
          const id = (evt.toolCallId && toolCallMsgIdRef.current.get(evt.toolCallId)) || toolIds[toolIds.length - 1];
          const isTerminal = evt.toolName === "run_in_terminal";
          if (id) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === id);
              if (idx >= 0) {
                const patch: Partial<ConsoleMessage> = { content: isTerminal ? "" : (evt.toolResult || ""), state: undefined };
                // Only override sandboxOutput if the server actually sent one
                if (evt.toolSandbox != null) patch.sandboxOutput = evt.toolSandbox;
                if ((evt as any).subAgentMessages) {
                  patch.subAgentMessages = (evt as any).subAgentMessages;
                  patch.subAgentName = (evt as any).subAgentName;
                }
                next[idx] = { ...next[idx], ...patch };
              }
              return next;
            });
          }
          if (evt.toolName === "delegate_task") {
            activeDelegationDepthRef.current = Math.max(0, activeDelegationDepthRef.current - 1);
            if (activeDelegationDepthRef.current === 0) activeDelegationMarkerRef.current = null;
            delegateTaskCardIdRef.current = null;
          }
          // Bridge: show "Thinking..." between tools so the state indicator never vanishes
          if (!assistantMsgId && !isTerminal) {
            assistantMsgId = nextId();
            pushRaw(assistantMsgId, { role: "assistant", content: "", state: "thinking" });
          }
          // If file tool Diff ready, defer — user must Accept/Reject before agent continues
          const FILE_TOOLS = ["edit_file"];
          if (FILE_TOOLS.includes(tn) && evt.toolResult === "Diff ready") {
            const fp = String(evt.toolParams?.path || evt.toolParams?.oldPath || "");
            deferredToolRef.current = {
              sessionId,
              toolCallId: evt.toolCallId || toolCallId,
              filePath: fp,
              name: fp.split(/[/\\]/).pop() || fp,
              originalContent: evt.originalContent ?? null,
            };
            agentDoneRef.current = true;
            return false;
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
            destructiveOriginal: evt.originalContent ?? undefined,
          });
          return false; // stop — wait for user to Allow/Deny
        } else if (evt.type === "browser_tool") {
          toolCallId = evt.toolCallId || "";
          // If this browser tool belongs to a sub-agent, nest it under the delegate_task card
          if ((evt as any).subAgentParentToolCallId && delegateTaskCardIdRef.current) {
            const parentId = delegateTaskCardIdRef.current;
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === parentId);
              if (idx >= 0) {
                const existing = next[idx].subAgentMessages || [];
                next[idx] = {
                  ...next[idx],
                  subAgentMessages: [...existing, { role: "tool", name: evt.toolName, content: `Running ${(evt.toolName || "").replace(/_/g, " ")}...` }],
                  state: undefined,
                };
              }
              return next;
            });
            return false;
          }
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
          const existingId = (evt.toolCallId && toolCallMsgIdRef.current.get(evt.toolCallId)) || (toolIds.length > 0 ? toolIds[toolIds.length - 1] : null);
          const reuseExisting = existingId && streamToolRef.current.get(existingId)?.name === tn;
          const id = reuseExisting ? existingId : nextId();
          if (!reuseExisting) toolIds.push(id);
          const marker = (evt as any).agentMarker || (reuseExisting ? streamToolRef.current.get(id)?.agentMarker : undefined) || activeDelegationMarkerRef.current || "main";
          streamToolRef.current.set(id, { name: tn, params: evt.toolParams || {}, agentMarker: marker });
          pushRaw(id, { role: "tool", content: "", toolName: tn, toolParams: evt.toolParams, toolCallId: evt.toolCallId, state: "waiting", agentMarker: marker });
          if (evt.toolCallId) toolCallMsgIdRef.current.set(evt.toolCallId, id);
          return false; // stop consuming this SSE stream
        } else if (evt.type === "done") {
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
              return next;
            });
            assistantMsgId = null;
            fileChangesRef.current = [];
            todosRef.current = [];
          }
          // Clear stale state indicators on all assistant/tool messages
          setMessages((prev) =>
            prev.map((m) =>
              (m.role === "assistant" || m.role === "tool") && m.state
                ? { ...m, state: undefined }
                : m
            )
          );
          currentThought = "";
          currentText = "";
          if (evt.reply && !assistantMsgId) {
            const normalizedReply = String(evt.reply).replace(/\r\n/g, "\n").trim();
            if (!normalizedReply || normalizedReply !== lastRenderedSummaryRef.current.trim()) {
              push({ role: "assistant", content: evt.reply, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined });
            }
          }
          setAgentStatus("completed");
          if (evt.usage) {
            totalTurnsRef.current += evt.usage.turns || 0;
            setAgentUsage({ ...evt.usage, turns: totalTurnsRef.current });
            // Persist usage to thread
            setThreads((prev) => prev.map((t) => t.id === activeThreadId ? { ...t, usage: evt.usage } : t));
          }
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
      setAgentStatus("completed");
      setLoading(false);
    }

    // ── Shared SSE event handler for continue loops ──
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
          // Track write_todos so the pending banner stays in sync
          const tn = evt.toolName;
          if (tn === "write_todos" && Array.isArray(evt.toolParams?.todos)) {
            todosRef.current = (evt.toolParams.todos as any[]).map((t: any): TodoItem => ({
              id: String(t.id || ""),
              text: String(t.text || ""),
              status: (["pending", "in_progress", "completed", "cancelled"].includes(String(t.status)) ? String(t.status) : "pending") as TodoItem["status"],
            }));
          }
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
            // Capture token count from file-changes before clearing, keyed by path
            for (const fc of fileChangesRef.current) {
              if (fc.tokenCount != null) fcTokenByPathRef.current.set(fc.path, fc.tokenCount);
            }
            fileChangesRef.current = [];
            todosRef.current = [];
          }
          currentThought = "";
          currentText = "";
          if (tn === "task_complete") {
            return true;
          }
          if (tn === "write_summary") {
            const writeSummaryKey = String(evt.toolCallId || "__latest__");
            writeSummaryRef.current.set(writeSummaryKey, {
              summary: String(evt.toolParams?.summary || ""),
              isSubAgent: !!(evt as any).isSubAgent,
              agentMarker: (evt as any).agentMarker || activeDelegationMarkerRef.current || ((evt as any).isSubAgent ? "code-writer" : "main"),
            });
            return true;
          }
          const id = nextId();
          toolIds.push(id);
          const isSubAgent2 = !!(evt as any).isSubAgent;
          const marker2 = (evt as any).agentMarker || activeDelegationMarkerRef.current || (isSubAgent2 ? "code-writer" : "main");
          streamToolRef.current.set(id, { name: tn, params: evt.toolParams || {}, agentMarker: marker2 });
          // Look up token count from the file-change just flushed above
          const fp = String(evt.toolParams?.path || evt.toolParams?.oldPath || "");
          const fcTokenCount = fp ? fcTokenByPathRef.current.get(fp) : undefined;
          // Open file in Monaco for file tools (close tab for delete to release handle)
          const FILE_EDIT_TOOLS2 = ["write_file", "edit_file", "delete_file", "rename_file"];
          if (FILE_EDIT_TOOLS2.includes(tn) && fp) {
            const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
            let p = fp;
            if (root && !/^[a-zA-Z]:/.test(p) && !p.startsWith("/")) {
              p = root + "/" + p.replace(/\\/g, "/");
            }
            if (tn === "delete_file") {
              closeEditorFile?.(p);
            } else {
              openEditorFile?.(p);
            }
          }
           pushRaw(id, { role: "tool", content: "", toolName: tn, toolParams: evt.toolParams, toolCallId: evt.toolCallId, state: "waiting", sandboxOutput: tn === "run_command" ? "" : undefined, tokenCount: fcTokenCount, agentMarker: marker2, ...(isSubAgent2 ? { subAgentName: "Sub-agent" } : {}) });
          if (evt.toolCallId) toolCallMsgIdRef.current.set(evt.toolCallId, id);
          // For run_in_terminal: store refs so permission_required and terminal bridge can find the card
          if (tn === "run_in_terminal") {
            agentTermMsgIdRef.current = id;
            agentTermOutputRef.current = "";
          }
          return true;
        }

        if (evt.type === "tool_end") {
          const DESTRUCTIVE = ["edit_file"];
          if (tn === "task_complete") {
            const tr = String(evt.toolResult || "");
            if (tr && tr !== "OK") {
              pushRaw(nextId(), { role: "system", content: tr });
            }
            return true;
          }
          if (tn === "write_summary") {
            const tr = String(evt.toolResult || "");
            const writeSummaryKey = String(evt.toolCallId || "__latest__");
            const storedSummary = writeSummaryRef.current.get(writeSummaryKey);
            writeSummaryRef.current.delete(writeSummaryKey);
            const looksLikeSummary = /###\s*Changes\s*Made/i.test(tr) && /###\s*Verification/i.test(tr) && /###\s*Outcome/i.test(tr);
            if (looksLikeSummary) {
              const summaryText = (storedSummary?.summary || tr).trim();
              if (summaryText && !storedSummary?.isSubAgent) {
                lastRenderedSummaryRef.current = summaryText.replace(/\r\n/g, "\n");
                pushRaw(nextId(), {
                  role: "assistant",
                  content: summaryText,
                  agentMarker: storedSummary?.agentMarker || "main",
                });
              }
            } else {
              const id = nextId();
              toolIds.push(id);
              pushRaw(id, { role: "tool", toolName: tn, content: tr, state: undefined });
            }
            return true;
          }
          // Update the last tool card (the one most recently started)
          const id = toolIds[toolIds.length - 1];
          if (id) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === id);
              if (idx >= 0) {
                // Don't show raw "Diff ready" as tool-card content — the
                // accept/reject buttons convey the action. Show nothing.
                const isDiffReady = evt.toolResult === "Diff ready";
                const patch: Partial<ConsoleMessage> = { content: isDiffReady ? "" : (evt.toolResult || ""), state: undefined };
                if (evt.toolSandbox != null) patch.sandboxOutput = evt.toolSandbox;
                if ((evt as any).subAgentMessages) {
                  patch.subAgentMessages = (evt as any).subAgentMessages;
                  patch.subAgentName = (evt as any).subAgentName;
                }
                next[idx] = { ...next[idx], ...patch };
              }
              return next;
            });
          }
          if (evt.toolName === "delegate_task") {
            activeDelegationDepthRef.current = Math.max(0, activeDelegationDepthRef.current - 1);
            if (activeDelegationDepthRef.current === 0) activeDelegationMarkerRef.current = null;
            delegateTaskCardIdRef.current = null;
          }
          // Bridge: show "Thinking..." between tools so the state indicator never vanishes
          if (!assistantMsgId) {
            assistantMsgId = nextId();
            pushRaw(assistantMsgId, { role: "assistant", content: "", state: "thinking" });
          }
          // Sync Monaco diffs for permission-gated destructive file tools
          if (DESTRUCTIVE.includes(tn) && id) {
            const params = evt.toolParams || {};
            const orig = evt.originalContent ?? null;
            const p = String(params.path || params.oldPath || "");
            const name = p.split(/[/\\]/).pop() || p;
            // Attach fileChange to the tool card message so findFcByPath / tool-card
            // accept/reject buttons can locate it (previously it was pushed to
            // fileChangesRef.current but never attached when Diff ready stops early).
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === id);
              if (idx < 0) return prev;
              const fc: FileChange = { path: p, name, status: "done", changeType: "write", originalContent: orig, deferred: true };
              let fcContent = "";
              let tkn = 0;
              if (tn === "write_file") {
                fcContent = String(params.content || "");
                fc.content = fcContent;
                tkn = Math.round(fcContent.length / 4);
              } else if (tn === "edit_file") {
                const oldStr = String(params.old_string || "");
                const newStr = String(params.new_string || "");
                fcContent = orig ? orig.split(oldStr).join(newStr) : newStr;
                fc.content = fcContent;
                // Token cost = only the changed strings sent to the API
                tkn = Math.round((oldStr.length + newStr.length) / 4);
              } else if (tn === "delete_file") {
                fc.changeType = "delete";
              } else if (tn === "rename_file") {
                fc.changeType = "rename";
                fc.content = String(params.newPath || "");
                fc.originalContent = p; // for reject: old path
              }
              fc.tokenCount = tkn;
              const next = [...prev];
              next[idx] = { ...next[idx], fileChanges: [fc], tokenCount: tkn };
              onRefreshFs?.();
              return next;
            });
            // Open file in editor for write_file / edit_file (with diff decorations if editing existing)
            if ((tn === "write_file" || tn === "edit_file") && applyAgentFileChanges) {
              const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
              let resolved = p;
              if (root && !/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith("/")) {
                resolved = root + "/" + resolved.replace(/\\/g, "/");
              }
              const content = tn === "write_file"
                ? String(params.content || "")
                : (orig || "").split(String(params.old_string || "")).join(String(params.new_string || ""));
              applyAgentFileChanges([{ name: p.split(/[/\\]/).pop() || p, content, fsPath: resolved, originalContent: orig }]);
              openEditorFile?.(resolved);
            }
            // If Diff ready, defer the result — wait for user Accept/Reject
            if (evt.toolResult === "Diff ready") {
              // Compute resolved path (same logic as openEditorFile above)
              const root = (getFsBasePath?.() || "").replace(/[/\\]$/, "");
              let resolvedPath = p;
              if (root && !/^[a-zA-Z]:/.test(resolvedPath) && !resolvedPath.startsWith("/")) {
                resolvedPath = root + "/" + resolvedPath.replace(/\\/g, "/");
              }
              deferredToolRef.current = {
                sessionId,
                toolCallId: evt.toolCallId || toolCallId,
                filePath: resolvedPath,
                name: p.split(/[/\\]/).pop() || p,
                originalContent: evt.originalContent ?? null,
              };
              agentDoneRef.current = true;
              return false;
            }
          } else {
            // Refresh files for non-permission-gated file tools
            if (tn === "write_file" || tn === "edit_file" || tn === "delete_file" || tn === "create_directory" || tn === "rename_file") {
              onRefreshFs?.();
            }
          }
          return true;
        }

        if (evt.type === "done") {
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined, todos: todosRef.current.length > 0 ? [...todosRef.current] : undefined };
              return next;
            });
            assistantMsgId = null;
            fileChangesRef.current = [];
            todosRef.current = [];
          } else if (evt.reply) {
            const normalizedReply = String(evt.reply).replace(/\r\n/g, "\n").trim();
            if (!normalizedReply || normalizedReply !== lastRenderedSummaryRef.current.trim()) {
              push({ role: "assistant", content: evt.reply, thought: currentThought });
            }
          }
          // Clear stale state indicators on all assistant/tool messages
          setMessages((prev) =>
            prev.map((m) =>
              (m.role === "assistant" || m.role === "tool") && m.state
                ? { ...m, state: undefined }
                : m
            )
          );
          setAgentStatus("completed");
          if (evt.usage) {
            totalTurnsRef.current += evt.usage.turns || 0;
            setAgentUsage({ ...evt.usage, turns: totalTurnsRef.current });
            // Persist usage to thread
            setThreads((prev) => prev.map((t) => t.id === activeThreadId ? { ...t, usage: evt.usage } : t));
          }
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
          // If this browser tool belongs to a sub-agent, nest it under the delegate_task card
          if ((evt as any).subAgentParentToolCallId && delegateTaskCardIdRef.current) {
            const parentId = delegateTaskCardIdRef.current;
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === parentId);
              if (idx >= 0) {
                const existing = next[idx].subAgentMessages || [];
                next[idx] = {
                  ...next[idx],
                  subAgentMessages: [...existing, { role: "tool", name: evt.toolName, content: `Running ${(evt.toolName || "").replace(/_/g, " ")}...` }],
                  state: undefined,
                };
              }
              return next;
            });
            return false;
          }
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
          const existingId = (evt.toolCallId && toolCallMsgIdRef.current.get(evt.toolCallId)) || (toolIds.length > 0 ? toolIds[toolIds.length - 1] : null);
          const reuseExisting = existingId && streamToolRef.current.get(existingId)?.name === tn;
          const id = reuseExisting ? existingId : nextId();
          if (!reuseExisting) toolIds.push(id);
          const marker = (evt as any).agentMarker || (reuseExisting ? streamToolRef.current.get(id)?.agentMarker : undefined) || activeDelegationMarkerRef.current || "main";
          streamToolRef.current.set(id, { name: tn, params: evt.toolParams || {}, agentMarker: marker });
          pushRaw(id, { role: "tool", content: "", toolName: tn, toolParams: evt.toolParams, toolCallId: evt.toolCallId, state: "waiting", agentMarker: marker });
          if (evt.toolCallId) toolCallMsgIdRef.current.set(evt.toolCallId, id);
          isPermission = false;
          return false; // stop — resume via while loop
        }

        if (evt.type === "permission_required") {
          toolCallId = evt.toolCallId || "";
          isPermission = true;
          // Ensure tool card has permissionPrompt so the user sees Allow/Deny buttons
          const pid = agentTermMsgIdRef.current || toolIds[toolIds.length - 1];
          if (pid) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === pid);
              if (idx >= 0) {
                next[idx] = {
                  ...next[idx],
                  permissionPrompt: `Allow: ${(evt as any).permissionCommand || "unknown command"}`,
                  destructiveOriginal: evt.originalContent ?? undefined,
                };
              }
              return next;
            });
          }
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
        if (err?.name !== "AbortError") {
          push({ role: "system", content: `Error: ${String(err)}` });
          setLoading(false);
          setAgentStatus("stopped");
        }
      }
    };
    continueDeferredRef.current = async (accepted: boolean, sid: string, tcid: string) => {
      // Loop: keep processing permissions / tools that arrive during the
      // deferred continue stream, just like the outer while loop does.
      isPermission = false;
      agentDoneRef.current = false;
      while (!agentDoneRef.current && sid && tcid) {
        await continueStreaming({
          sessionId: sid,
          toolCallId: tcid,
          toolResult: accepted ? "OK" : "rejected",
          model: selectedModel,
          thinking: isThinking,
          consoleContext: getConsoleContext?.() || "",
        });
        // Only pass toolResult on the first call; subsequent iterations use "OK"
        accepted = true;

        if (isPermission) {
          if (signal?.aborted) return;
          const permMsgId = agentTermMsgIdRef.current || toolIds[toolIds.length - 1];
          pendingPermissionMsgIdRef.current = permMsgId || null;
          const queuedDecision = queuedPermissionDecisionRef.current;
          const granted = queuedDecision != null
            ? queuedDecision
            : await new Promise<boolean>((resolve) => {
                permissionResolveRef.current = (decision: boolean) => {
                  pendingPermissionMsgIdRef.current = null;
                  resolve(decision);
                };
              });
          queuedPermissionDecisionRef.current = null;
          permissionResolveRef.current = null;
          pendingPermissionMsgIdRef.current = null;
          const permTool = permMsgId ? streamToolRef.current.get(permMsgId) : undefined;

          if (!granted && permMsgId) {
            setMessages((prev) => prev.filter((m) => m.id !== permMsgId));
            agentTermMsgIdRef.current = null;
            agentTermOutputRef.current = "";
          }

          if (!signal?.aborted) {
            if (permTool?.name === "run_in_terminal") {
              if (permMsgId && granted) {
                const cmd = String(permTool?.params?.command || "");
                if (cmd && agentTerminalBridge) {
                  agentTerminalBridge.setCommand({ id: permMsgId!, command: cmd });
                  agentTermOutputRef.current = "";
                }
                setMessages((prev) => {
                  const next = [...prev];
                  const idx = next.findIndex((m) => m.id === permMsgId);
                  if (idx >= 0) next[idx] = { ...next[idx], permissionPrompt: undefined };
                  return next;
                });
              }
              let termResult: string | null = null;
              if (granted && permTool?.name === "run_in_terminal" && agentTerminalBridge) {
                const FINISH_TIMEOUT_MS = 120_000;
                const EARLY_PATTERNS = /(?:running on|listening on|server started|serving on|started server|development server|watching for changes|compiled successfully|webpack compiled|vite .* ready|localhost:[0-9]|127\.0\.0\.1:[0-9]|0\.0\.0\.0:[0-9]|Traceback\s*\(most\s+recent\s+call\s+last\)|ModuleNotFoundError|ImportError|IndentationError|TabError|SyntaxError|NameError|TypeError|AttributeError|FileNotFoundError|PermissionError|ValueError|KeyError|IndexError|ZeroDivisionError|npm\s+ERR!|Error:\s*Cannot\s+find\s+module|Error:\s*listen\s+EADDRINUSE|Error:\s*listen\s+EACCES|panic:|fatal\s+error:|thread\s+'main'\s+panicked|error\[E\d|command\s+not\s+found)/im;
                let earlyDetected = false;
                const exitCode = await new Promise<number | null>((resolve) => {
                  let ended = false;
                  const finish = (code: number | null) => {
                    if (!ended) { ended = true; resolve(code); unsubFin(); unsubOut(); }
                  };
                  const timer = setTimeout(() => finish(null), FINISH_TIMEOUT_MS);
                  const unsubFin = agentTerminalBridge.onFinish((code: number | null) => {
                    clearTimeout(timer);
                    finish(code);
                  });
                  const unsubOut = agentTerminalBridge.onOutput((_text: string) => {
                    if (!ended && !earlyDetected && EARLY_PATTERNS.test(agentTermOutputRef.current)) {
                      earlyDetected = true;
                      clearTimeout(timer);
                      setTimeout(() => finish(null), 500);
                    }
                  });
                });
                termResult = agentTermOutputRef.current.trim() || "(no terminal output)";
                agentTermOutputRef.current = "";
                setMessages((prev) => {
                  const next = [...prev];
                  const idx = next.findIndex((m) => m.id === permMsgId);
                  if (idx >= 0) next[idx] = { ...next[idx], content: termResult || agentTermOutputRef.current, state: undefined, sandboxOutput: agentTermOutputRef.current };
                  return next;
                });
              } else if (!granted && permTool?.name === "run_in_terminal") {
                agentTermOutputRef.current = "";
              }
              isPermission = false;
              // Send the real terminal output to the LLM (not "OK").
              await continueStreaming({
                sessionId: sid,
                toolCallId: toolCallId || sid,
                permissionGranted: granted,
                toolResult: termResult ?? undefined,
                model: selectedModel,
                thinking: isThinking,
                consoleContext: getConsoleContext?.() || "",
              });
              // Update tcid for the next loop iteration
              tcid = toolCallId || sid;
            } else {
              isPermission = false;
              // Non-terminal, non-browser permission: just continue
              tcid = toolCallId || sid;
            }
          }
        }
      }
    };

    // ── Loop: keep processing browser_tool / permission_required until done ──
    while (!agentDoneRef.current && sessionId && toolCallId) {

    // If permission is needed, wait for user response then continue
    if (isPermission) {
      if (signal.aborted) { setLoading(false); return; }
      const permMsgId = agentTermMsgIdRef.current || toolIds[toolIds.length - 1];
      pendingPermissionMsgIdRef.current = permMsgId || null;
      const queuedDecision = queuedPermissionDecisionRef.current;
      const granted = queuedDecision != null
        ? queuedDecision
        : await new Promise<boolean>((resolve) => {
            permissionResolveRef.current = (decision: boolean) => {
              pendingPermissionMsgIdRef.current = null;
              resolve(decision);
            };
          });
      queuedPermissionDecisionRef.current = null;
      permissionResolveRef.current = null;
      pendingPermissionMsgIdRef.current = null;
      const permTool = permMsgId ? streamToolRef.current.get(permMsgId) : undefined;

      if (!granted && permMsgId) {
        // Denied — remove the tool card
        setMessages((prev) => prev.filter((m) => m.id !== permMsgId));
        agentTermMsgIdRef.current = null;
        agentTermOutputRef.current = "";
      }

      if (!signal.aborted) {
        if (permTool?.name === "run_in_terminal") {
          // run_in_terminal: execute command in terminal bridge
          if (permMsgId && granted) {
            const cmd = String(permTool?.params?.command || "");
            if (cmd && agentTerminalBridge) {
              agentTerminalBridge.setCommand({ id: permMsgId, command: cmd });
              agentTermOutputRef.current = "";
            }
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === permMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], permissionPrompt: undefined };
              return next;
            });
          }

          // For run_in_terminal, wait for the command to exit (or server to start)
          // before continuing. The full terminal output is sent as the tool result
          // so the agent sees runtime errors before proceeding.
          let termResult: string | null = null;
          if (granted && permTool?.name === "run_in_terminal" && agentTerminalBridge) {
            const FINISH_TIMEOUT_MS = 120_000; // fallback for commands that never exit
            // Patterns that indicate we can stop waiting and let the agent see the output
            const EARLY_PATTERNS = /(?:running on|listening on|server started|serving on|started server|development server|watching for changes|compiled successfully|webpack compiled|vite .* ready|localhost:[0-9]|127\.0\.0\.1:[0-9]|0\.0\.0\.0:[0-9]|Traceback\s*\(most\s+recent\s+call\s+last\)|ModuleNotFoundError|ImportError|IndentationError|TabError|SyntaxError|NameError|TypeError|AttributeError|FileNotFoundError|PermissionError|ValueError|KeyError|IndexError|ZeroDivisionError|npm\s+ERR!|Error:\s*Cannot\s+find\s+module|Error:\s*listen\s+EADDRINUSE|Error:\s*listen\s+EACCES|panic:|fatal\s+error:|thread\s+'main'\s+panicked|error\[E\d|command\s+not\s+found)/im;
            let earlyDetected = false;

            const exitCode = await new Promise<number | null>((resolve) => {
              let ended = false;
              const finish = (code: number | null) => {
                if (!ended) { ended = true; resolve(code); unsubFin(); unsubOut(); }
              };
              const timer = setTimeout(() => finish(null), FINISH_TIMEOUT_MS);
              const unsubFin = agentTerminalBridge.onFinish((code: number | null) => {
                clearTimeout(timer);
                finish(code);
              });
              // Short-circuit when server output or error output is detected.
              // Wait 500ms after detection to let the rest of the traceback/error flush.
              const unsubOut = agentTerminalBridge.onOutput((_text: string) => {
                if (!ended && !earlyDetected && EARLY_PATTERNS.test(agentTermOutputRef.current)) {
                  earlyDetected = true;
                  clearTimeout(timer);
                  setTimeout(() => finish(null), 500);
                }
              });
            });
            termResult = agentTermOutputRef.current.trim() || "(no terminal output)";
            agentTermOutputRef.current = ""; // clear after capture
          } else if (!granted && permTool?.name === "run_in_terminal") {
            agentTermOutputRef.current = "";
          }

          isPermission = false;
          await continueStreaming({
            sessionId, toolCallId,
            permissionGranted: granted,
            toolResult: termResult ?? undefined,
            model: selectedModel, thinking: isThinking,
            consoleContext: getConsoleContext?.() || "",
          });
        }
      } else {
        agentDoneRef.current = true;
      }
    } else if (sessionId && toolCallId && !isPermission) {
      // Only process browser tools here.  File tools (rename_file, write_file,
      // etc.) are handled by acceptFile → continueDeferredRef — don't try to
      // execute them via executeBrowserAction.
      const lastToolId = toolCallId ? toolCallMsgIdRef.current.get(toolCallId) || toolIds[toolIds.length - 1] : toolIds[toolIds.length - 1];
      const toolData = lastToolId ? streamToolRef.current.get(lastToolId) : undefined;
      const isBrowser = toolData?.name?.startsWith("browser_");
      if (isBrowser) {
        let toolResult = "Tool not available.";
        if (executeBrowserAction) {
          toolResult = await executeBrowserAction(toolData!.name, toolData!.params || {});
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
          await continueStreaming({ sessionId, toolCallId, toolResult, model: selectedModel, thinking: isThinking, consoleContext: getConsoleContext?.() || "" });
        } else {
          agentDoneRef.current = true;
        }
      } else {
        // Not a browser tool — nothing to process in this loop.
        agentDoneRef.current = true;
      }
    }
    }

    // Keep loading if a file tool (edit/write/delete) is waiting for Accept/Reject
    setLoading(deferredToolRef.current != null);
  }, [getConsoleContext, refreshFileTreeContext, executeBrowserAction, push, getFsBasePath, applyEditorFiles, onRefreshFs, threads]);

  // helper: push a message with explicit id
  const pushRaw = useCallback((id: string, msg: Omit<ConsoleMessage, "id" | "when">) => {
    setMessages((prev) => {
      // Update if message with this ID already exists (prevents "same key" errors)
      const idx = prev.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...msg, id, when: Date.now() };
        return next;
      }
      return [...prev, { ...msg, id, when: Date.now() }];
    });
  }, []);

  // ── Send / Stop ──

  const send = useCallback(async () => {
    const msg = input.trim();
    if (!msg) return;
    const tid = ensureThread();
    updateThreadTitle(tid, msg);
    setInput("");
    onGoalChange(msg);
    setLoading(true);
    setAgentStatus("idle");
    setAgentUsage(null);
    setThumbsFeedback(null);
    lastRenderedSummaryRef.current = "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    preRoundRef.current = messages;
    push({ role: "user", content: msg });

    try {
      await runAgent(tid, msg, ctrl.signal);
    } catch (err: any) {
      if (err?.name !== "AbortError") push({ role: "assistant", content: `Error: ${String(err)}` });
      setAgentStatus("completed");
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
    const usage = effectiveUsage ?? undefined;
    const t: ChatThread = { id, sessionId: id, title: `Fork of ${activeThreadId || "chat"}`, messages: [...messages], createdAt: Date.now(), usage };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setAgentStatus("idle");
    setAgentUsage(null);
  }, [messages, activeThreadId, effectiveUsage]);

  const copyChat = useCallback(() => {
    const text = messages.map((m) => {
      const prefix = m.role === "user" ? "You" : m.role === "assistant" ? "AI" : m.toolName ? `Tool: ${m.toolName}` : "System";
      return `### ${prefix}\n${m.content}`;
    }).join("\n\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  }, [messages]);

  const copyTurn = useCallback((messages: ConsoleMessage[]) => {
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        lines.push("", m.content, "");
      } else if (m.role === "tool" && m.toolName) {
        lines.push(`toolName: ${m.toolName}`);
        lines.push("status: success");
        if (m.toolParams?.path || m.toolParams?.oldPath) {
          lines.push(`filePath: ${m.toolParams.path || m.toolParams.oldPath}`);
        }
        if (m.toolParams?.command) {
          lines.push(`command: ${m.toolParams.command}`);
        }
        lines.push("");
      } else if (m.role === "assistant" && m.content) {
        lines.push(m.content);
        lines.push("");
      }
    }
    navigator.clipboard?.writeText(lines.join("\n").trim()).catch(() => {});
  }, []);

  const retryTurn = useCallback((messages: ConsoleMessage[]) => {
    const userMsg = messages.find((m) => m.role === "user");
    if (userMsg) {
      setInput(userMsg.content);
      setAgentStatus("idle");
      setAgentUsage(null);
    }
  }, []);

  const [thumbsFeedback, setThumbsFeedback] = useState<"up" | "down" | null>(null);
  const feedback = useCallback((v: "up" | "down") => setThumbsFeedback(v), []);
  const [expandedDiffPath, setExpandedDiffPath] = useState<string | null>(null);
  const [expandedGroupDiffKey, setExpandedGroupDiffKey] = useState<string | null>(null);

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

  const getGroupDiffFiles = useCallback((items: ConsoleMessage[]) => {
    const files: { path: string; name: string; diff: string }[] = [];
    for (const m of items) {
      if (m.role === "assistant" && m.fileChanges && m.fileChanges.length > 0) {
        for (const fc of m.fileChanges) {
          if (fc.changeType === "write" && fc.originalContent != null && fc.content) {
            files.push({ path: fc.path, name: fc.name, diff: computeUnifiedDiff(fc.originalContent || "", fc.content) });
          }
        }
      }
    }
    return files;
  }, [computeUnifiedDiff]);

  // ── Pending items for the input-area banner ──
  const pendingTodos = useMemo(() => {
    // Only use the latest todos — when the agent calls write_todos again,
    // old messages still carry stale todo arrays. We want just the newest.
    let latestTodos: (TodoItem & { msgId: string })[] = [];
    for (const m of messages) {
      if (m.todos && m.todos.length > 0) {
        latestTodos = m.todos
          .filter((t) => t.status !== "completed" && t.status !== "cancelled")
          .map((t) => ({ ...t, msgId: m.id }));
      }
    }
    return latestTodos;
  }, [messages]);

  const unconfirmedFileChanges: { path: string; name: string; msgId: string }[] = useMemo(() => {
    const result: { path: string; name: string; msgId: string }[] = [];
    for (const m of messages) {
      if (m.fileChanges) {
        for (const fc of m.fileChanges) {
          if (!fc.accepted && !fc.rejected && fc.deferred) result.push({ path: fc.path, name: fc.name, msgId: m.id });
        }
      }
    }
    return result;
  }, [messages]);

  const hasPendingFileActions = unconfirmedFileChanges.length > 0;

  const acceptAllChanges = useCallback(() => {
    // Collect paths before state update so side effects can run OUTSIDE the
    // setMessages functional updater (avoiding setState-during-render in EditorPane).
    const pathsToAccept: string[] = [];
    let renameOldPath = "";
    let renameNewPath = "";
    for (const m of messages) {
      if (m.fileChanges) {
        for (const fc of m.fileChanges) {
          if (!fc.accepted && !fc.rejected && fc.deferred) {
            pathsToAccept.push(fc.path);
            if (fc.changeType === "rename" && fc.content) {
              renameOldPath = fc.path;
              renameNewPath = fc.content;
            }
          }
        }
      }
    }
    if (pathsToAccept.length === 0) return;

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
      return changed ? next : prev;
    });

    // Notify editor to clear all agent diffs + refresh file tree
    onRefreshFs?.();
    for (const p of pathsToAccept) {
      acceptEditorChange?.(resolvePath(p));
    }

    // Handle deferred tool: resume the agent stream
    const dt = deferredToolRef.current;
    if (dt) {
      if (renameOldPath && renameNewPath) {
        renameEditorFile?.(resolvePath(renameOldPath), resolvePath(renameNewPath));
      }
      setLoading(true);
      deferredToolRef.current = null;
      continueDeferredRef.current?.(true, dt.sessionId, dt.toolCallId);
    }
  }, [messages, acceptEditorChange, onRefreshFs, resolvePath, renameEditorFile]);

  const [showPendingBanner, setShowPendingBanner] = useState(false);

  // Clear diff panel when messages change
  useEffect(() => { setExpandedDiffPath(null); setExpandedGroupDiffKey(null); }, [messages.length]);

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
    // If this is a deferred tool, skip local apply and just resume agent stream
    const dt = deferredToolRef.current;
    if (dt) {
      const norm = (s: string) => s.replace(/\\/g, "/");
      const nDt = norm(dt.filePath);
      const nFc = norm(fc.path);
      if (nFc === nDt || nDt.endsWith("/" + fc.name) || nDt.endsWith("\\" + fc.name)) {
        acceptEditorChange?.(resolvePath(dt.filePath));
        onRefreshFs?.();
        if (fc.changeType === "rename" && fc.content) {
          renameEditorFile?.(resolvePath(fc.path), resolvePath(fc.content));
        } else if (fc.changeType === "delete") {
          closeEditorFile?.(resolvePath(dt.filePath));
        }
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === msgId);
          if (idx >= 0 && next[idx].fileChanges) {
            next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: true, rejected: false } : c) };
          }
          return next;
        });
        setLoading(true);
        deferredToolRef.current = null;
        continueDeferredRef.current?.(true, dt.sessionId, dt.toolCallId);
        return;
      }
    }
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
      // Close the editor tab for the deleted file
      closeEditorFile?.(resolvePath(fc.path));
    } else if (fc.changeType === "rename" && fc.content) {
      onRefreshFs?.();
      renameEditorFile?.(resolvePath(fc.path), resolvePath(fc.content));
    }
    if (fc.changeType !== "delete") onRefreshFs?.();
    acceptEditorChange?.(resolvePath(fc.path));
    setMessages((prev) => {
      const next = [...prev];
      const idx = next.findIndex((m) => m.id === msgId);
      if (idx >= 0 && next[idx].fileChanges) {
        next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: true, rejected: false } : c) };
      }
      return next;
    });
  }, [acceptEditorChange, applyEditorFiles, onRefreshFs, getFsBasePath, resolvePath, closeEditorFile, renameEditorFile]);

  const rejectFile = useCallback((fc: FileChange, msgId: string) => {
    // If this is a deferred tool, skip local revert and just resume agent stream
    const dt = deferredToolRef.current;
    if (dt) {
      const norm = (s: string) => s.replace(/\\/g, "/");
      const nDt = norm(dt.filePath);
      const nFc = norm(fc.path);
      if (nFc === nDt || nDt.endsWith("/" + fc.name) || nDt.endsWith("\\" + fc.name)) {
        rejectEditorChange?.(resolvePath(dt.filePath));
        // For new files (write with no original), close tab and delete from disk
        if (fc.changeType === "write" && fc.originalContent === null) {
          closeEditorFile?.(resolvePath(fc.path));
          fetch("/api/fs/delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: resolvePath(fc.path) }),
          }).catch(() => {});
        }
        onRefreshFs?.();
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === msgId);
          if (idx >= 0 && next[idx].fileChanges) {
            next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: false, rejected: true } : c) };
          }
          return next;
        });
        setLoading(true);
        deferredToolRef.current = null;
        continueDeferredRef.current?.(false, dt.sessionId, dt.toolCallId);
        return;
      }
    }
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
        rejectEditorChange?.(resolvePath(fc.path!));
        onRefreshFs?.();
      } catch (err) {
        console.error("Reject revert failed:", err);
      }
    })();
  }, [rejectEditorChange, getFsBasePath, onRefreshFs, resolvePath, closeEditorFile]);

  // Helper: find the file-change entry (and its parent msg id) for a given file path
  const findFcByPath = useCallback((fp: string): { fc: FileChange; msgId: string } | null => {
    for (const m of messages) {
      if (m.fileChanges) {
        for (const fc of m.fileChanges) {
          if (fc.path === fp && !fc.accepted && !fc.rejected) {
            return { fc, msgId: m.id };
          }
        }
      }
    }
    return null;
  }, [messages]);

  // Tool-card accept/reject (syncs FileChange, Monaco, and deferred flow)
  const handleToolCardAccept = useCallback((filePath: string) => {
    const resolved = resolvePath(filePath);
    const found = findFcByPath(filePath);
    if (found) {
      acceptFile(found.fc, found.msgId);
    } else {
      // Fallback: try resolved path if fileChange wasn't found by relative path
      const found2 = findFcByPath(resolved);
      if (found2) acceptFile(found2.fc, found2.msgId);
    }
  }, [findFcByPath, acceptFile, resolvePath]);

  const handleToolCardReject = useCallback((filePath: string) => {
    const resolved = resolvePath(filePath);
    const found = findFcByPath(filePath);
    if (found) {
      rejectFile(found.fc, found.msgId);
    } else {
      const found2 = findFcByPath(resolved);
      if (found2) rejectFile(found2.fc, found2.msgId);
    }
  }, [findFcByPath, rejectFile, resolvePath]);

// ── Standalone utilities ──

function truncPath(p: string) {
  const s = p.replace(/\\/g, "/");
  return s.length > 50 ? "..." + s.slice(-47) : s;
}

// ── Standalone components ──

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

function normalizeAssistantMarkdown(text: string): string {
  let normalized = text.replace(/\r\n/g, "\n").trim();
  const summaryHeadingRe = /###\s*(Changes\s*Made|Verification|Outcome|Todo\s*Progress)\b/gi;
  if (summaryHeadingRe.test(normalized)) {
    normalized = normalized.replace(/\s+(###\s*(?:Changes\s*Made|Verification|Outcome|Todo\s*Progress)\b)/gi, "\n\n$1");
    normalized = normalized.replace(
      /(###\s*(?:Changes\s*Made|Verification|Outcome|Todo\s*Progress)[^\n]*?)\s+-\s+/gi,
      (_m, heading) => `${String(heading).trim()}\n- `,
    );
  }
  return normalized;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.filter(Boolean).map((part, i) => {
    if (/^`[^`]+`$/.test(part)) {
      return <code key={`${keyPrefix}-code-${i}`} className="agent-md-inline-code">{part.slice(1, -1)}</code>;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={`${keyPrefix}-strong-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`${keyPrefix}-text-${i}`}>{part}</span>;
  });
}

function MarkdownPreview({ text, msgId }: { text: string; msgId: string }) {
  const lines = normalizeAssistantMarkdown(text).split("\n");
  const blocks: ReactNode[] = [];

  for (let i = 0; i < lines.length;) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?$/);
    if (fence) {
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith("```")) {
        codeLines.push(lines[j]);
        j++;
      }
      blocks.push(
        <pre key={`${msgId}-pre-${i}`} className="agent-code"><code>{codeLines.join("\n")}</code></pre>,
      );
      i = j < lines.length ? j + 1 : lines.length;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div key={`${msgId}-h-${i}`} className={`agent-md-heading agent-md-h${level}`}>
          {renderInlineMarkdown(heading[2].trim(), `${msgId}-h-${i}`)}
        </div>,
      );
      i++;
      continue;
    }

    // Table: | col | col | ... header row followed by |---|---| separator
    if (/^\|.+\|$/.test(trimmed)) {
      const tableRows: string[][] = [];
      let j = i;
      // Collect consecutive table rows
      while (j < lines.length && /^\|.+\|$/.test(lines[j].trim())) {
        const cells = lines[j].trim()
          .replace(/^\|/, "").replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        tableRows.push(cells);
        j++;
      }
      // Must have at least 2 rows (header + separator or header + data)
      if (tableRows.length >= 2) {
        // Find the separator row (contains only ---, :--, --:, :--: patterns)
        let sepIdx = -1;
        for (let r = 0; r < tableRows.length; r++) {
          if (tableRows[r].every((c) => /^:?-{3,}:?$/.test(c))) {
            sepIdx = r;
            break;
          }
        }
        if (sepIdx === 0 && tableRows.length >= 3) {
          // Header is row 0, separator is row 0 (matched), data starts at row 1
          // Actually if sepIdx === 0, the first row matched as separator — skip past it
          // and the next row is the real header? No, markdown tables don't work that way.
          // If the first row looks like a separator, just treat rows 1+ as body, no header.
          blocks.push(
            <table key={`${msgId}-table-${i}`} className="agent-md-table">
              <tbody>
                {tableRows.slice(1).map((row, ri) => (
                  <tr key={`${msgId}-table-${i}-tr-${ri}`}>
                    {row.map((cell, ci) => (
                      <td key={`${msgId}-table-${i}-tr-${ri}-td-${ci}`}>
                        {renderInlineMarkdown(cell, `${msgId}-table-${i}-tr-${ri}-td-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>,
          );
        } else if (sepIdx === 1) {
          // Standard: row 0 = header, row 1 = separator, rows 2+ = body
          const header = tableRows[0];
          const body = tableRows.slice(2);
          // Compute alignments from separator
          const aligns = tableRows[1].map((c) => {
            if (c.startsWith(":") && c.endsWith(":")) return "center";
            if (c.endsWith(":")) return "right";
            return "left";
          });
          blocks.push(
            <table key={`${msgId}-table-${i}`} className="agent-md-table">
              <thead>
                <tr>
                  {header.map((cell, ci) => (
                    <th key={`${msgId}-table-${i}-th-${ci}`} style={{ textAlign: aligns[ci] || "left" as any }}>
                      {renderInlineMarkdown(cell, `${msgId}-table-${i}-th-${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={`${msgId}-table-${i}-tr-${ri}`}>
                    {row.map((cell, ci) => (
                      <td key={`${msgId}-table-${i}-tr-${ri}-td-${ci}`} style={{ textAlign: aligns[ci] || "left" as any }}>
                        {renderInlineMarkdown(cell, `${msgId}-table-${i}-tr-${ri}-td-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>,
          );
        } else {
          // No separator found — just render as text lines
          for (let r = i; r < j; r++) {
            blocks.push(
              <p key={`${msgId}-p-${r}`} className="agent-md-p">
                {renderInlineMarkdown(lines[r].trim(), `${msgId}-p-${r}`)}
              </p>,
            );
          }
        }
      } else {
        // Single table-like line — treat as paragraph
        blocks.push(
          <p key={`${msgId}-p-${i}`} className="agent-md-p">
            {renderInlineMarkdown(trimmed, `${msgId}-p-${i}`)}
          </p>,
        );
      }
      i = j;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^[-*]\s+/.test(lines[j].trim())) {
        items.push(lines[j].trim().replace(/^[-*]\s+/, ""));
        j++;
      }
      blocks.push(
        <ul key={`${msgId}-ul-${i}`} className="agent-md-list">
          {items.map((item, idx) => (
            <li key={`${msgId}-ul-${i}-${idx}`}>{renderInlineMarkdown(item, `${msgId}-ul-${i}-${idx}`)}</li>
          ))}
        </ul>,
      );
      i = j;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^\d+\.\s+/.test(lines[j].trim())) {
        items.push(lines[j].trim().replace(/^\d+\.\s+/, ""));
        j++;
      }
      blocks.push(
        <ol key={`${msgId}-ol-${i}`} className="agent-md-list agent-md-olist">
          {items.map((item, idx) => (
            <li key={`${msgId}-ol-${i}-${idx}`}>{renderInlineMarkdown(item, `${msgId}-ol-${i}-${idx}`)}</li>
          ))}
        </ol>,
      );
      i = j;
      continue;
    }

    const para: string[] = [trimmed];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trim();
      if (!next || /^#{1,6}\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next) || /^```/.test(next)) break;
      para.push(next);
      j++;
    }
    blocks.push(
      <p key={`${msgId}-p-${i}`} className="agent-md-p">
        {renderInlineMarkdown(para.join(" "), `${msgId}-p-${i}`)}
      </p>,
    );
    i = j;
  }

  return <div className="agent-md-preview">{blocks}</div>;
}

const iconForRole = (r: string) => r === "user" ? "account" : r === "assistant" ? "sparkle" : r === "tool" ? "tools" : "info";
const stateLabel = (s: string) => ({ thinking: "Thinking...", generating: "Generating...", waiting: "Wait a moment...", file_viewing: "Reading file..." } as Record<string, string>)[s] || "";
const getCacheSummary = (usage: UsageStats | null | undefined) => {
  const hit = usage?.promptCacheHitTokens ?? 0;
  const miss = usage?.promptCacheMissTokens ?? 0;
  const total = hit + miss;
  const pct = total > 0 ? Math.round((hit / total) * 100) : null;
  return { hit, miss, total, pct };
};

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

  // Group messages by user-assistant turns so we can insert a slim footer
  // after each assistant response group: user → assistant(+tools) → footer.
  const messageGroups = useMemo(() => {
    const groups: { key: string; items: ConsoleMessage[] }[] = [];
    for (const m of safeMessages) {
      if (m.role === "user" || groups.length === 0) {
        groups.push({ key: m.id, items: [m] });
      } else {
        groups[groups.length - 1].items.push(m);
      }
    }
    return groups;
  }, [safeMessages]);

  const lastGroupIsUserOnly = messageGroups.length > 0
    && messageGroups[messageGroups.length - 1].items.every((m) => m.role === "user");

  return (
    <div className="console-panel">
      {/* ── Toolbar ── */}
      <div className={`agent-toolbar${loading ? " agent-toolbar-locked" : ""}`}>
        <button className="agent-toolbar-btn" disabled={loading} onClick={newTask} title={loading ? "Agent is running" : "New Task"}>
          <i className="codicon codicon-add" /> New Task
        </button>
        <button className="agent-toolbar-btn" disabled={loading} onClick={() => setShowHistory((v) => !v)} title={loading ? "Agent is running" : "Show History"}>
          <i className="codicon codicon-history" /> {showHistory ? "Hide History" : "History"}
        </button>
        {messages.length > 0 && (
          <button className="agent-toolbar-btn" disabled={loading} onClick={exportChat} title={loading ? "Agent is running" : "Export chat"}>
            <i className="codicon codicon-save" />
          </button>
        )}
      </div>

      {/* ── History panel ── */}
      {showHistory && (
        <div className="agent-history-panel" ref={historyPanelRef}>
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
      <div className="console-list" ref={consoleListRef}>
        {safeMessages.length === 0 && (
          <div className="agent-empty">Ask anything — DeepSeek can write code, debug, browse the web, run commands, and manage files.</div>
        )}
        {messageGroups.map((group, gi) => {
           const isLast = gi === messageGroups.length - 1;
           const hasAssistant = group.items.some((m) => m.role !== "user");
           return (
              <div key={group.key}>
              {group.items.map((msg) => (
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
                  <button className="agent-btn agent-btn-accept" onClick={(e) => { e.stopPropagation(); handlePermissionResponse(msg.id, true); }}>Allow</button>
                  <button className="agent-btn agent-btn-reject" onClick={(e) => { e.stopPropagation(); handlePermissionResponse(msg.id, false); }}>Deny</button>
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
              <div key={`${msg.id}-tool`} className={`agent-tool-card agent-tool-card-${msg.agentMarker || "main"}${msg.state === "waiting" ? " streaming" : ""}`}>
                <div className="agent-tool-card-header">
                  {msg.state === "waiting" ? <span className="agent-spinner" /> : <i className="codicon codicon-check" />}
                  <i className={`codicon codicon-${msg.toolName === "delegate_task" ? "hubot" : msg.toolName.startsWith("browser_") ? "globe" : msg.toolName === "run_in_terminal" ? "terminal" : msg.toolName === "read_file" ? "file-code" : msg.toolName === "grep" ? "search" : msg.toolName === "list_files" || msg.toolName === "search_files" ? "folder-opened" : "tools"}`} />
                  {(() => {
                    const FILE_CARD_TOOLS = ["write_file", "edit_file", "delete_file", "rename_file"];
                    if (FILE_CARD_TOOLS.includes(msg.toolName)) {
                      const fp = String(msg.toolParams?.path || msg.toolParams?.oldPath || "");
                      const tkn = msg.tokenCount ?? 0;
                      return (
                        <>
                          <span className="agent-tool-card-name">{msg.toolName.replace(/_/g, " ")}</span>
                          <span className="agent-tool-card-file">{truncPath(fp)}</span>
                          {tkn > 0 && (
                            <span className="agent-tool-card-tokens"><i className="codicon codicon-arrow-down" />{tkn}</span>
                          )}
                        </>
                      );
                    }
                    return (
                      <>
                        <span className="agent-tool-card-name">{msg.toolName.replace("browser_", "").replace(/_/g, " ")}</span>
                        {msg.toolName === "delegate_task" && <span className="agent-tool-card-label">sub-agent</span>}
                        {msg.subAgentName && msg.toolName !== "delegate_task" && <span className="agent-tool-card-label">sub-agent</span>}
                        {msg.toolName === "run_in_terminal" && <span className="agent-tool-card-label">terminal</span>}
                        {msg.toolName === "run_command" && <span className="agent-tool-card-label">sandbox</span>}
                        {msg.toolParams && msg.toolName !== "run_in_terminal" && msg.toolName !== "run_command" && (
                          <span className="agent-tool-card-args">
                            {Object.entries(msg.toolParams)
                              .filter(([k]) => msg.toolName === "delegate_task" ? k !== "task" : true)
                              .map(([k, v]) => (
                                <span key={k}>{k}: {String(v).slice(0, 60)}</span>
                              ))}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
                {/* ── Sub-agent container inside tool card ── */}
                {msg.toolName === "delegate_task" && msg.subAgentMessages && msg.subAgentMessages.length > 0 && (
                  <div className="agent-sub-agent">
                    <div className="agent-sub-agent-header"
                      onClick={() => setExpandedSubAgents((prev) => {
                        const next = new Set(prev);
                        if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                        return next;
                      })}>
                      <i className={`codicon codicon-${expandedSubAgents.has(msg.id) ? "chevron-down" : "chevron-right"}`} />
                      <span>{msg.subAgentName || "Sub-agent"} ({msg.subAgentMessages.length} messages)</span>
                    </div>
                    {expandedSubAgents.has(msg.id) && (
                      <div className="agent-sub-agent-body">
                        {msg.subAgentMessages.map((m, i) => {
                          const hasReasoning = !!m.reasoning_content;
                          const hasToolName = !!m.name;
                          const isToolCall = hasToolName;
                          const roleClass = isToolCall ? "agent-msg-tool"
                            : m.role === "tool" ? "agent-msg-tool"
                            : m.role === "user" ? "agent-msg-user"
                            : "agent-msg-assistant";
                          return (
                            <div key={i} className={`agent-sub-agent-msg agent-msg ${roleClass}${isToolCall ? " turn-tool" : ""}${hasReasoning ? " turn-reasoning" : ""}${m.role === "tool" ? " turn-result" : ""}${m.role === "user" ? " turn-user" : ""}${!isToolCall && m.role === "assistant" ? " turn-text" : ""}`}>
                              {m.reasoning_content && (
                                <div className="agent-sub-agent-thought">{m.reasoning_content}</div>
                              )}
                              {m.name && (
                                <div className="agent-sub-agent-tool">
                                  <i className="codicon codicon-tools" /> {m.name.replace(/_/g, " ")}
                                </div>
                              )}
                              {m.content && !m.name && m.role === "assistant" && (
                                <div className="agent-sub-agent-text">{m.content}</div>
                              )}
                              {m.role === "user" && (
                                <div className="agent-sub-agent-text agent-sub-agent-user">User: {m.content}</div>
                              )}
                              {m.role === "tool" && (
                                <div className="agent-sub-agent-result">
                                  {m.content.length > 500
                                    ? m.content  // browser_screenshot / browser_get_dom: show full output
                                    : m.content}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {/* ── Accept/reject for file tools ── */}
                {(() => {
                  const FILE_TOOLS = ["edit_file"];
                  if (!FILE_TOOLS.includes(msg.toolName) || msg.state === "waiting") return null;
                  const fp = String(msg.toolParams?.path || msg.toolParams?.oldPath || "");
                  // Check if already resolved
                  let isResolved = false;
                  let isAccepted = false;
                  for (const mmm of messages) {
                    if (mmm.fileChanges) {
                      for (const fcc of mmm.fileChanges) {
                        if (fcc.path === fp && (fcc.accepted || fcc.rejected)) {
                          isResolved = true;
                          isAccepted = !!fcc.accepted;
                          break;
                        }
                      }
                      if (isResolved) break;
                    }
                  }
                  if (isResolved) {
                    const label = isAccepted ? "Applied" : "Dismissed";
                    return (
                      <div className="agent-tool-card-actions">
                        <span className="agent-tool-card-action-label">{label}</span>
                      </div>
                    );
                  }
                  return (
                    <div className="agent-tool-card-actions">
                      <button className="agent-btn agent-btn-accept" onClick={(e) => { e.stopPropagation(); handleToolCardAccept(fp); }} title="Accept">
                        <i className="codicon codicon-check" /> Accept
                      </button>
                      <button className="agent-btn agent-btn-reject" onClick={(e) => { e.stopPropagation(); handleToolCardReject(fp); }} title="Reject">
                        <i className="codicon codicon-close" /> Reject
                      </button>
                    </div>
                  );
                })()}
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
                          <button className="agent-btn agent-btn-accept" onClick={(e) => { e.stopPropagation(); handlePermissionResponse(msg.id, true); }}>Allow</button>
                          <button className="agent-btn agent-btn-reject" onClick={(e) => { e.stopPropagation(); handlePermissionResponse(msg.id, false); }}>Deny</button>
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
                    {msg.role === "user"
                      ? <CollapsedCode text={msg.content} msgId={msg.id} />
                      : msg.role === "assistant"
                        ? <MarkdownPreview text={msg.content} msgId={msg.id} />
                        : msg.content}
                  </div>
                  {msg.role === "user" && (
                    <div className="agent-msg-actions">
                      <button className="agent-icon-btn" title="Copy" onClick={() => copyText(msg.content)}><i className="codicon codicon-copy" /></button>
                      <button className="agent-icon-btn" title="Delete" onClick={() => handleActionClick(() => removeMessage(msg.id))}><i className="codicon codicon-trash" /></button>
                      <button className="agent-icon-btn" title="Revert to before this message" onClick={() => handleActionClick(() => revertToPreRound(msg.id))}><i className="codicon codicon-discard" /></button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {/* Compact footer after each assistant turn (except the last — main footer handles that) */}
        {!isLast && hasAssistant && (
          <div className="agent-footer">
            <div className="agent-footer-status">
              <i className="codicon codicon-check" /> Response complete
            </div>
            {(() => {
              const ctx = effectiveUsage?.contextLimit ?? 128_000;
              const turnChars = group.items.reduce((sum, m) => sum + (m.content?.length || 0), 0);
              const est = Math.round(turnChars / 4);
              const pct = Math.min(100, (est / ctx) * 100);
              const radius = 8;
              const circumference = 2 * Math.PI * radius;
              const offset = circumference - (pct / 100) * circumference;
              return (
                <div className="agent-footer-usage" title={`~${est} estimated tokens of ${ctx.toLocaleString()} context limit`}>
                  <svg className="agent-footer-usage-ring" width="20" height="20" viewBox="0 0 20 20">
                    <circle className="agent-footer-usage-ring-bg" cx="10" cy="10" r={radius} />
                    <circle
                      className={`agent-footer-usage-ring-fill${est > ctx * 0.8 ? " high" : ""}`}
                      cx="10" cy="10" r={radius}
                      strokeDasharray={circumference}
                      strokeDashoffset={offset}
                    />
                  </svg>
                  <span className="agent-footer-usage-text">
                    {Math.round(pct)}%
                  </span>
                </div>
              );
            })()}
            <div className="agent-footer-actions">
              <button className={`agent-footer-btn${thumbsFeedback === "up" ? " active" : ""}`} title="Good response" onClick={() => feedback("up")}>
                <i className={`codicon codicon-${thumbsFeedback === "up" ? "thumbsup-filled" : "thumbsup"}`} />
              </button>
              <button className={`agent-footer-btn${thumbsFeedback === "down" ? " active" : ""}`} title="Bad response" onClick={() => feedback("down")}>
                <i className={`codicon codicon-${thumbsFeedback === "down" ? "thumbsdown-filled" : "thumbsdown"}`} />
              </button>
              {(() => {
                const gDiff = getGroupDiffFiles(group.items);
                if (gDiff.length === 0) return null;
                const isOpen = expandedGroupDiffKey === group.key;
                return (
                  <>
                    <button className={`agent-footer-btn${isOpen ? " active" : ""}`} title="View changes" onClick={() => setExpandedGroupDiffKey(isOpen ? null : group.key)}>
                      <i className="codicon codicon-diff" /> {gDiff.length}
                    </button>
                  </>
                );
              })()}
              <button className="agent-footer-btn" title="Copy this turn" onClick={() => copyTurn(group.items)}>
                <i className="codicon codicon-copy" />
              </button>
              <button className="agent-footer-btn" title="Retry this turn" onClick={() => retryTurn(group.items)}>
                <i className="codicon codicon-refresh" />
              </button>
            </div>
            {expandedGroupDiffKey === group.key && (
              <div className="agent-group-diff-panel">
                {getGroupDiffFiles(group.items).map((f) => (
                  <div key={f.path} className="agent-group-diff-file">
                    <div className="agent-group-diff-file-header" onClick={() => setExpandedDiffPath(expandedDiffPath === f.path ? null : f.path)}>
                      <i className={`codicon codicon-${expandedDiffPath === f.path ? "chevron-down" : "chevron-right"}`} />
                      {f.path}
                    </div>
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
        {isLast && !hasAssistant && lastGroupIsUserOnly && (
          <div className="agent-turn-footer agent-turn-footer-pending">
            <span className="agent-spinner" /> Waiting for agent...
          </div>
        )}
      </div>
    );
})}
    {loading && !messages[messages.length - 1]?.state && (
          <div className="agent-msg agent-msg-system">
            <div className="agent-state"><span className="agent-spinner" /> Thinking...</div>
          </div>
        )}
        {/* ── Completion footer ── */}
        {!loading && safeMessages.length > 0 && (
          <div className="agent-footer">
            <div className="agent-footer-status">
              <i className={`codicon codicon-${agentStatus === "stopped" ? "debug-stop" : "check-all"}`} />
              {agentStatus === "stopped" ? "Stopped" : "Completed"}
            </div>
            {(() => {
              const est = effectiveUsage?.estimatedTokens ?? 0;
              const ctx = effectiveUsage?.contextLimit ?? 128_000;
              const pct = Math.min(100, (est / ctx) * 100);
              const cache = getCacheSummary(effectiveUsage);
              const radius = 8;
              const circumference = 2 * Math.PI * radius;
              const offset = circumference - (pct / 100) * circumference;
              const titleParts = [
                `${est.toLocaleString()} estimated tokens`,
                `${effectiveUsage?.turns ?? 0} turns`,
                `${ctx.toLocaleString()} context limit (${Math.round(pct)}%)`,
              ];
              if (effectiveUsage?.requestCount) titleParts.push(`${effectiveUsage.requestCount} DeepSeek requests`);
              if ((effectiveUsage?.totalTokens ?? 0) > 0) {
                titleParts.push(`${(effectiveUsage?.promptTokens ?? 0).toLocaleString()} prompt · ${(effectiveUsage?.completionTokens ?? 0).toLocaleString()} completion · ${(effectiveUsage?.totalTokens ?? 0).toLocaleString()} total API tokens`);
              }
              if (cache.total > 0 && cache.pct != null) {
                titleParts.push(`cache ${cache.pct}% hit rate · ${cache.hit.toLocaleString()} hit tokens · ${cache.miss.toLocaleString()} miss tokens`);
              }
              return (
                <div className="agent-footer-usage" title={titleParts.join(" · ")}>
                  <svg className="agent-footer-usage-ring" width="20" height="20" viewBox="0 0 20 20">
                    <circle className="agent-footer-usage-ring-bg" cx="10" cy="10" r={radius} />
                    <circle
                      className={`agent-footer-usage-ring-fill${est > ctx * 0.8 ? " high" : ""}`}
                      cx="10" cy="10" r={radius}
                      strokeDasharray={circumference}
                      strokeDashoffset={offset}
                    />
                  </svg>
                  <span className="agent-footer-usage-text">
                    {Math.round(pct)}% &middot; {effectiveUsage?.turns ?? 0}t{cache.total > 0 && cache.pct != null ? ` · c${cache.pct}%` : ""}
                  </span>
                </div>
              );
            })()}
            <div className="agent-footer-actions">
              {changedFiles.length > 0 && (
                <button className="agent-footer-btn" title={`${changedFiles.length} file${changedFiles.length > 1 ? "s" : ""} changed`}>
                  <i className="codicon codicon-diff" /> {changedFiles.length}
                </button>
              )}
            </div>
            <div className="agent-footer-actions">
              <button className={`agent-footer-btn${thumbsFeedback === "up" ? " active" : ""}`} title="Good response" onClick={() => feedback("up")}>
                <i className={`codicon codicon-${thumbsFeedback === "up" ? "thumbsup-filled" : "thumbsup"}`} />
              </button>
              <button className={`agent-footer-btn${thumbsFeedback === "down" ? " active" : ""}`} title="Bad response" onClick={() => feedback("down")}>
                <i className={`codicon codicon-${thumbsFeedback === "down" ? "thumbsdown-filled" : "thumbsdown"}`} />
              </button>
              <button className="agent-footer-btn" title="Copy last turn" onClick={() => copyTurn(messageGroups[messageGroups.length - 1]?.items || [])}>
                <i className="codicon codicon-copy" />
              </button>
              <button className="agent-footer-btn" title="Retry last turn" onClick={() => retryTurn(messageGroups[messageGroups.length - 1]?.items || [])}>
                <i className="codicon codicon-refresh" />
              </button>
              <button className="agent-footer-btn" title="Fork this chat" onClick={forkChat}>
                <i className="codicon codicon-repo-forked" />
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Pending todos / changes banner ── */}
      {(pendingTodos.length > 0 || hasPendingFileActions) && (
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
          {hasPendingFileActions && (
            <button className="agent-pending-accept-all" onClick={acceptAllChanges}>
              <i className="codicon codicon-check-all" /> {unconfirmedFileChanges.length === 1 ? "Accept change" : `Accept all (${unconfirmedFileChanges.length} changes)`}
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
            placeholder={apiKeyConfigured ? "Ask the agent...  (Shift+Enter for new line)" : "Add an API key to start chatting..."}
            disabled={loading || !apiKeyConfigured}
            rows={3}
          />
          <div className="agent-input-buttons">
            <button className="agent-context-btn" title="Mention a file" onClick={insertHash}>#</button>
            {loading ? (
              <button className="agent-send-btn agent-stop-btn" onClick={stop} title="Stop"><i className="codicon codicon-debug-stop" /></button>
            ) : (
              <button className="agent-send-btn" onClick={send} disabled={!input.trim() || !apiKeyConfigured} title="Send"><i className="codicon codicon-send" /></button>
            )}
          </div>
        </div>
        {/* ── Model selector ── */}
        <div className="agent-model-bar">
          <div className="agent-model-selector" ref={modelPickerRef}>
            <button className="agent-model-btn" onClick={() => { if (!apiKeyConfigured) return; setModelPickerOpen((v) => { if (!v) { setEditingModel(false); setEditingApiKey(false); } return !v; }); void refreshAgentConfig(); }} title={apiKeyConfigured ? "Configure model" : "Add an API key to start chatting"}>
              {!configChecked ? (
                <span style={{color: "#888"}}>Checking...</span>
              ) : !apiKeyConfigured ? (
                <>
                  <i className="codicon codicon-warning" style={{color: "#d29922"}} />
                  <span style={{color: "#d29922"}}>Add API Key</span>
                </>
              ) : (
                <>
                  <i className="codicon codicon-symbol-method" />
                  <span>{selectedModel || <span style={{color: "#888", fontStyle: "italic"}}>Select model...</span>}</span>
                  <span className="agent-model-mode-badge">{isThinking ? "Thinking" : "Chat"}</span>
                </>
              )}
              <i className={`codicon codicon-chevron-${modelPickerOpen ? "down" : "up"}`} />
            </button>
            {modelPickerOpen && apiKeyConfigured && (
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
                        <button className="agent-model-preset-icon-btn" onClick={() => { editingModelRef.current = true; setEditingModel(true); selectPreset(p.id); }} title="Modify">
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
                {editingModel ? (
                  <>
                    <div className="agent-model-popup-title" style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
                      <span>Edit</span>
                      <button className="agent-model-apikey-cancel" onClick={() => { setEditingModel(false); setEditingApiKey(false); setTempApiKey(""); }}>Cancel</button>
                    </div>
                    {/* Model name input */}
                    <div className="agent-model-name-edit">
                      <label className="agent-model-label">Model</label>
                      <input
                        className="agent-model-apikey-input"
                        type="text"
                        placeholder="Enter model name..."
                        value={editModelInput}
                        onChange={(e) => { setEditModelInput(e.target.value); }}
                      />
                      {apiKeyConfigured && !editModelInput.trim() && (
                        <div className="agent-mention-hint">Enter a model name to save this configuration.</div>
                      )}
                    </div>
                    {/* Thinking / Non-thinking toggle */}
                    <button className="agent-model-item" onClick={toggleThinking}>
                      <span className="agent-model-item-name">Mode</span>
                      <span className="agent-model-item-desc">{isThinking ? "Thinking (reasoning)" : "Non-thinking (chat)"}</span>
                      <i className={`codicon codicon-${isThinking ? "check" : "circle-outline"}`} style={{color: isThinking ? "#4ec94e" : undefined}} />
                    </button>
                    {editingApiKey ? (
                      <div className="agent-model-apikey-edit">
                        <input
                          className="agent-model-apikey-input"
                          type="password"
                          placeholder="sk-..."
                          value={tempApiKey}
                          onChange={(e) => setTempApiKey(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !savingApiKey) void saveApiKey(); }}
                          autoFocus
                        />
                        <button className="agent-model-apikey-save" onClick={() => { void saveApiKey(); }} disabled={!tempApiKey.trim() || savingApiKey}>Save</button>
                        <button className="agent-model-apikey-cancel" onClick={() => { setEditingApiKey(false); setTempApiKey(""); }} disabled={savingApiKey}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <div className="agent-model-apikey-display">
                          <i className={`codicon ${apiKeyConfigured ? "codicon-key" : "codicon-warning"}`} />
                          <span>
                            {apiKeySource === "session"
                              ? "API key stored persistently on this device."
                              : "No API key configured."}
                          </span>
                        </div>
                        <div className="agent-model-apikey-row">
                          <button className="agent-model-item" onClick={() => { setTempApiKey(""); setEditingApiKey(true); }}>
                            <span className="agent-model-item-name">{apiKeyConfigured ? "Replace API Key" : "Add API Key"}</span>
                            <span className="agent-model-item-desc">Stored on this device and persists across restarts</span>
                            <i className="codicon codicon-key" />
                          </button>
                          {apiKeySource === "session" && (
                            <button className="agent-model-item agent-model-item-danger" onClick={() => { void clearApiKey(); }} disabled={savingApiKey}>
                              <span className="agent-model-item-name">Remove API Key</span>
                              <i className="codicon codicon-trash" />
                            </button>
                          )}
                        </div>
                        {!apiKeyConfigured && (
                          <div className="agent-mention-hint">Add a DeepSeek API key to start chatting.</div>
                        )}
                      </>
                    )}
                    <div className="agent-model-popup-divider" />
                    {/* Save / Clear buttons */}
                    <div className="agent-model-preset-save-row">
                      <button className="agent-model-apikey-save" onClick={saveAsPreset} disabled={!editModelInput.trim()} style={{background: "#4ec94e"}}>
                        <i className="codicon codicon-save" /> {activePreset ? "Update" : "Save"}
                      </button>
                      {activePreset && (
                        <button className="agent-model-apikey-save" onClick={savePresetAsNew} disabled={!editModelInput.trim()}>
                          <i className="codicon codicon-diff-added" /> Save as New
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <button className="agent-model-item" onClick={() => setEditingModel(true)}>
                    <span className="agent-model-item-name">Edit Configuration</span>
                    <span className="agent-model-item-desc">Change model, mode, or API key</span>
                    <i className="codicon codicon-edit" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
