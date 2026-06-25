import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type { LoopEvent } from "../../../server/loop";

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
  /** Kind of change: "write" (default), "create" (new dir), "delete". */
  changeType?: "write" | "create" | "delete";
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

const STORAGE_KEY = "harness-chat-threads";

function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveThreads(threads: ChatThread[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
}

// ── Props ──
interface Props {
  events: LoopEvent[];
  goal: string;
  onGoalChange: (value: string) => void;
  onRun: () => void;
  connected: boolean;
  getConsoleContext?: () => string;
  executeBrowserAction?: (name: string, params: Record<string, unknown>) => Promise<string>;
  getProjectFiles?: () => Promise<string[]>;
  getFsBasePath?: () => string;
  /** Reflect a file change in the editor (open tab, set content). */
  refreshEditor?: (files: { name: string; content: string }[]) => void;
  /** Refresh the file explorer panel. */
  onRefreshFs?: () => void;
}

// ── Component ──

export default function TestConsole({ events, goal, onGoalChange, onRun, connected, getConsoleContext, executeBrowserAction, getProjectFiles, getFsBasePath, refreshEditor, onRefreshFs }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ConsoleMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const preRoundRef = useRef<ConsoleMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Agent completion footer state
  const [agentStatus, setAgentStatus] = useState<"idle" | "completed" | "stopped">("idle");
  const [agentUsage, setAgentUsage] = useState<{ estimatedTokens: number; contextLimit: number; turns: number } | null>(null);

  // ── Thread management ──
  const [threads, setThreads] = useState<ChatThread[]>(loadThreads);
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [showHistory, setShowHistory] = useState(false);
  const [fileList, setFileList] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);

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
    if (threads.length > 0) saveThreads(threads);
  }, [threads]);

  const ensureThread = useCallback(() => {
    if (activeThreadId && threads.some((t) => t.id === activeThreadId)) return activeThreadId;
    const id = `thread-${Date.now()}`;
    const t: ChatThread = { id, title: `Chat ${threads.length + 1}`, messages: [], createdAt: Date.now() };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setMessages([]);
    return id;
  }, [activeThreadId, threads]);

  const newTask = useCallback(() => {
    const id = `thread-${Date.now()}`;
    const t: ChatThread = { id, title: `Chat ${threads.length + 1}`, messages: [], createdAt: Date.now() };
    setThreads((prev) => [...prev, t]);
    setActiveThreadId(id);
    setMessages([]);
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
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (activeThreadId === id) {
      setActiveThreadId("");
      setMessages([]);
    }
  }, [activeThreadId]);

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
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const revertToPreRound = useCallback(() => {
    setMessages(preRoundRef.current);
  }, []);

  const copyText = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  // ── Streaming agent loop ──
  const streamToolRef = useRef<Map<string, { name: string; params: Record<string, unknown> }>>(new Map());
  const fileChangesRef = useRef<FileChange[]>([]);

  const applyEditorFiles = useCallback((changes: FileChange[]) => {
    if (!refreshEditor) return;
    const files = changes
      .filter((fc) => fc.status === "done" && fc.content && !fc.rejected)
      .map((fc) => ({ name: fc.path.split(/[/\\]/).pop() || fc.path, content: fc.content!, fsPath: fc.path }));
    if (files.length > 0) refreshEditor(files);
  }, [refreshEditor]);

  const runAgent = useCallback(async (userMessage: string, signal: AbortSignal) => {
    const consoleSnapshot = getConsoleContext?.() || "";
    const root = getFsBasePath?.() || "";
    streamToolRef.current = new Map();
    fileChangesRef.current = [];

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
    let currentThought = "";
    let currentText = "";
    let assistantMsgId: string | null = null;
    const toolIds: string[] = []; // track tool messages within this round

    try {
      await consumeSSE("/api/chat/agent/stream", { message: userMessage, context: consoleSnapshot, projectRoot: root }, async (evt) => {
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
            const tokenCount = content.length;
            fileChangesRef.current.push({
              path: p, name, content, changeType: "write",
              status: "streaming",
              tokenCount,
            });
          } else if (tn === "delete_file" && evt.toolParams?.path) {
            const p = String(evt.toolParams.path);
            const name = p.split(/[/\\]/).pop() || p;
            fileChangesRef.current.push({
              path: p, name, changeType: "delete",
              status: "done",
            });
          } else if (tn === "create_directory" && evt.toolParams?.path) {
            const p = String(evt.toolParams.path);
            const name = p.split(/[/\\]/).pop() || p;
            fileChangesRef.current.push({
              path: p, name, changeType: "create",
              status: "done",
            });
          }
          // End the assistant message's streaming state
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: [...fileChangesRef.current] };
              return next;
            });
            assistantMsgId = null;
          }
          currentThought = "";
          currentText = "";
          const isCmd = evt.toolName === "run_command";
          const id = nextId();
          toolIds.push(id);
          streamToolRef.current.set(id, { name: evt.toolName, params: evt.toolParams || {} });
          pushRaw(id, { role: "tool", content: "", toolName: evt.toolName, toolParams: evt.toolParams, state: "waiting", sandboxOutput: isCmd ? "" : undefined });
        } else if (evt.type === "tool_end") {
          // Switch file changes from streaming to done
          if (evt.toolName === "write_file") {
            for (const fc of fileChangesRef.current) {
              if (fc.status === "streaming") {
                fc.status = "done";
                fc.linesAdded = Math.max(1, Math.round((fc.tokenCount ?? 0) / 40)); // rough estimate
                fc.linesRemoved = 0;
              }
            }
            // Auto-open in editor
            applyEditorFiles(fileChangesRef.current);
          }
          const id = toolIds[toolIds.length - 1];
          const isCmd = evt.toolName === "run_command";
          if (id) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === id);
              if (idx >= 0) next[idx] = { ...next[idx], content: isCmd ? "" : (evt.toolResult || ""), state: undefined, sandboxOutput: evt.toolSandbox || undefined };
              return next;
            });
          }
        } else if (evt.type === "browser_tool") {
          toolCallId = evt.toolCallId || "";
          // Show the browser tool being executed
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: [...fileChangesRef.current] };
              return next;
            });
            assistantMsgId = null;
          }
          currentThought = "";
          currentText = "";
          const id = nextId();
          toolIds.push(id);
          streamToolRef.current.set(id, { name: evt.toolName, params: evt.toolParams || {} });
          pushRaw(id, { role: "tool", content: "", toolName: evt.toolName, toolParams: evt.toolParams, state: "waiting" });
          return false; // stop consuming this SSE stream
        } else if (evt.type === "done") {
          if (assistantMsgId) {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) next[idx] = { ...next[idx], state: undefined, thought: currentThought, fileChanges: [...fileChangesRef.current] };
              return next;
            });
          }
          currentThought = "";
          currentText = "";
          if (evt.reply && !assistantMsgId) {
            push({ role: "assistant", content: evt.reply, thought: currentThought, fileChanges: fileChangesRef.current.length > 0 ? [...fileChangesRef.current] : undefined });
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

    // If we got a browser_tool, execute it and continue
    if (sessionId && toolCallId) {
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

      // Continue via streaming
      if (!signal.aborted) {
        try {
          await consumeSSE("/api/chat/agent/stream/continue", { sessionId, toolCallId, toolResult }, async (evt) => {
            if (signal.aborted) return false;
            if (evt.type === "thinking") {
              currentThought += (evt.text || "");
              if (!assistantMsgId) {
                assistantMsgId = nextId();
                setMessages((prev) => [...prev, { id: assistantMsgId!, role: "assistant", content: "", when: Date.now(), state: "thinking", thought: currentThought }]);
              } else {
                setMessages((prev) => {
                  const next = [...prev];
                  const idx = next.findIndex((m) => m.id === assistantMsgId);
                  if (idx >= 0) next[idx] = { ...next[idx], thought: currentThought, state: "thinking" };
                  return next;
                });
              }
            } else if (evt.type === "text") {
              currentText += (evt.text || "");
              if (!assistantMsgId) {
                assistantMsgId = nextId();
                setMessages((prev) => [...prev, { id: assistantMsgId!, role: "assistant", content: currentText, when: Date.now(), state: "generating", thought: currentThought }]);
              } else {
                setMessages((prev) => {
                  const next = [...prev];
                  const idx = next.findIndex((m) => m.id === assistantMsgId);
                  if (idx >= 0) next[idx] = { ...next[idx], content: currentText, state: "generating" };
                  return next;
                });
              }
            } else if (evt.type === "done") {
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
            } else if (evt.type === "warning") {
              push({ role: "system", content: `\u26A0 ${evt.warning || ""}`, isWarning: true });
            } else if (evt.type === "error") {
              push({ role: "system", content: `Error: ${evt.error || "Unknown"}` });
              setAgentStatus("stopped");
              setLoading(false);
            }
            return evt.type !== "done" && evt.type !== "error" && evt.type !== "warning";
          });
        } catch (err: any) {
          if (err?.name !== "AbortError") push({ role: "system", content: `Error: ${String(err)}` });
        }
      }
    }

    setLoading(false);
  }, [getConsoleContext, executeBrowserAction, push, getFsBasePath, applyEditorFiles, onRefreshFs]);

  // helper: push a message with explicit id
  const pushRaw = useCallback((id: string, msg: Omit<ConsoleMessage, "id" | "when">) => {
    setMessages((prev) => [...prev, { ...msg, id, when: Date.now() }]);
  }, []);

  // ── Send / Stop ──

  const send = useCallback(async () => {
    const msg = input.trim();
    if (!msg) return;
    ensureThread();
    updateThreadTitle(msg);
    setInput("");
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
      // Delete via server
      fetch("/api/fs/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fc.path }),
      }).catch(() => {});
    }
    // For "create" — directory already exists, just acknowledge.
    onRefreshFs?.();
    setMessages((prev) => {
      const next = [...prev];
      const idx = next.findIndex((m) => m.id === msgId);
      if (idx >= 0 && next[idx].fileChanges) {
        next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: true, rejected: false } : c) };
      }
      return next;
    });
  }, [applyEditorFiles, onRefreshFs]);

  const rejectFile = useCallback((fc: FileChange, msgId: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const idx = next.findIndex((m) => m.id === msgId);
      if (idx >= 0 && next[idx].fileChanges) {
        next[idx] = { ...next[idx], fileChanges: next[idx].fileChanges!.map((c) => c.path === fc.path ? { ...c, accepted: false, rejected: true } : c) };
      }
      return next;
    });
  }, []);

  // ── Render helpers ──

  const truncPath = (p: string) => {
    const s = p.replace(/\\/g, "/");
    return s.length > 50 ? "..." + s.slice(-47) : s;
  };

  const FileChangeCard = ({ fc, msgId, onAccept, onReject }: { fc: FileChange; msgId: string; onAccept: (fc: FileChange, msgId: string) => void; onReject: (fc: FileChange, msgId: string) => void }) => {
    const isStreaming = fc.status === "streaming";
    const isResolved = fc.accepted || fc.rejected;
    const ct = fc.changeType || "write";
    const icon = isStreaming ? "loading"
      : fc.accepted ? "check"
      : fc.rejected ? "close"
      : ct === "delete" ? "trash"
      : ct === "create" ? "folder-opened"
      : "diff";
    const actionLabel = ct === "delete" ? (fc.accepted ? "Deleted" : "Kept")
      : ct === "create" ? (fc.accepted ? "Created" : "Skipped")
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
            {ct === "write" && (
              <button className="agent-fc-diff-btn" title="Open diff"><i className="codicon codicon-diff" /></button>
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
  };

  const TodoCard = ({ todos }: { todos: TodoItem[] }) => {
    if (!todos || todos.length === 0) return null;
    return (
      <div className="agent-todo-card">
        <div className="agent-todo-header"><i className="codicon codicon-checklist" /> Tasks</div>
        {todos.map((t) => {
          let icon = "circle-outline";
          if (t.status === "in_progress") icon = "loading";
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
  };

  const CollapsedCode = ({ text }: { text: string }) => {
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
          <details key={i} className="agent-code-collapse">
            <summary className="agent-code-collapse-summary"><i className="codicon codicon-code" /> {label}</summary>
            <pre className="agent-code"><code>{body}</code></pre>
          </details>
        );
      }
      return <span key={i}>{p}</span>;
    })}</>;
  };

  const iconForRole = (r: string) => r === "user" ? "account" : r === "assistant" ? "sparkle" : r === "tool" ? "tools" : "info";
  const stateLabel = (s: string) => ({ thinking: "Thinking...", generating: "Generating...", waiting: "Wait a moment...", file_viewing: "Reading file..." } as Record<string, string>)[s] || "";

  // ── UI ──

  // Ensure message-id counter survives HMR (which resets module-level _mid).
  syncMid(messages);

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
            <i className="codicon codicon-save" /> Export
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

      {/* ── Messages ── */}
      <div className="console-list">
        {messages.length === 0 && (
          <div className="agent-empty">Ask the agent to do anything — write code, run tests, browse the web, manage files...</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`agent-msg agent-msg-${msg.role}${msg.isWarning ? " agent-msg-warning" : ""}`}>
            {msg.state && (
              <div className="agent-state">
                {msg.state === "thinking" && <span className="agent-spinner" />}
                {stateLabel(msg.state)}
              </div>
            )}
            {msg.viewingFile && (
              <div className="agent-file-view"><i className="codicon codicon-eye" /> {msg.viewingFile}</div>
            )}
            {/* Sandbox only shown inside tool card for tool messages; standalone for non-tool */}
            {msg.role !== "tool" && msg.sandboxOutput && (
              <div className="agent-sandbox">
                <div className="agent-sandbox-header"><i className="codicon codicon-terminal" /> Terminal</div>
                <pre className="agent-sandbox-out">{msg.sandboxOutput}</pre>
              </div>
            )}
            {msg.permissionPrompt && (
              <div className="agent-perms">
                <i className="codicon codicon-warning" />
                <span>{msg.permissionPrompt}</span>
                <div className="agent-perms-actions">
                  <button className="agent-btn agent-btn-accept">Allow</button>
                  <button className="agent-btn agent-btn-reject">Deny</button>
                </div>
              </div>
            )}
            {msg.pendingDiff && (
              <div className="agent-diff">
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
              <div className="agent-fc-list">
                {msg.fileChanges.map((fc) => (
                  <FileChangeCard key={fc.path} fc={fc} msgId={msg.id} onAccept={acceptFile} onReject={rejectFile} />
                ))}
              </div>
            )}
            {/* Todo list */}
            {msg.todos && msg.todos.length > 0 && <TodoCard todos={msg.todos} />}
            {msg.thought && (
              <details className="agent-thought" open={!!msg.state}>
                <summary className="agent-thought-summary"><i className="codicon codicon-lightbulb" /> Thought process</summary>
                <div className="agent-thought-body">{msg.thought}</div>
              </details>
            )}
            {/* Tool execution card */}
            {msg.role === "tool" && msg.toolName && (
              <div className={`agent-tool-card${msg.state === "waiting" ? " streaming" : ""}`}>
                <div className="agent-tool-card-header">
                  {msg.state === "waiting" ? <span className="agent-spinner" /> : <i className="codicon codicon-check" />}
                  <i className={`codicon codicon-${msg.toolName.startsWith("browser_") ? "globe" : msg.toolName === "run_command" ? "terminal" : msg.toolName === "read_file" ? "file-code" : "tools"}`} />
                  <span className="agent-tool-card-name">{msg.toolName.replace("browser_", "").replace(/_/g, " ")}</span>
                  {msg.toolParams && (
                    <span className="agent-tool-card-args">
                      {Object.entries(msg.toolParams).map(([k, v]) => (
                        <span key={k}>{k}: {String(v).slice(0, 60)}</span>
                      ))}
                    </span>
                  )}
                </div>
                {msg.sandboxOutput && (
                  <div className="agent-sandbox">
                    <pre className="agent-sandbox-out">{msg.sandboxOutput}</pre>
                  </div>
                )}
                {msg.content && !msg.sandboxOutput && (
                  <pre className="agent-code">{msg.content}</pre>
                )}
              </div>
            )}
            {/* Fallback for tool msgs without tool-card */}
            {msg.role === "tool" && !msg.toolName && msg.content && (
              <pre className="agent-code">{msg.content}</pre>
            )}
            {msg.role !== "tool" && msg.content && (
              <div className="agent-body">
                <span className="agent-role-icon"><i className={`codicon codicon-${iconForRole(msg.role)}`} /></span>
                <div className="agent-content">
                  <div className="agent-text">
                    {msg.role === "user" ? <CollapsedCode text={msg.content} /> : msg.content}
                  </div>
                  {msg.role === "user" && (
                    <div className="agent-msg-actions">
                      <button className="agent-icon-btn" title="Copy" onClick={() => copyText(msg.content)}><i className="codicon codicon-copy" /></button>
                      <button className="agent-icon-btn" title="Delete" onClick={() => removeMessage(msg.id)}><i className="codicon codicon-trash" /></button>
                      <button className="agent-icon-btn" title="Revert to before this message" onClick={revertToPreRound}><i className="codicon codicon-discard" /></button>
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
        {!loading && agentStatus !== "idle" && messages.length > 0 && (
          <div className="agent-footer">
            <div className="agent-footer-status">
              {agentStatus === "completed" ? (
                <><i className="codicon codicon-check-all" /> Completed</>
              ) : (
                <><i className="codicon codicon-debug-stop" /> Manually Stopped</>
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
                  ~{agentUsage.estimatedTokens} / {agentUsage.contextLimit} tokens &middot; {agentUsage.turns} turns
                </span>
              </div>
            )}
            <div className="agent-footer-actions">
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
          placeholder="Ask the agent...  (Shift+Enter for new line)"
          disabled={loading}
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
    </div>
  );
}
