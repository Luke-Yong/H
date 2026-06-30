// ── Harness Agent: tool-calling loop for DeepSeek ──
// Supports browser tools (screenshot, DOM, click, type, eval, navigate),
// filesystem tools (read_file, write_file), and terminal (run_command).
//
// Two loops:
//   agentLoop()        — blocking, returns final result (used by /api/chat/agent)
//   agentLoopStream()  — async generator, yields SSE events (used by /api/chat/agent/stream)
//
// Conversation state is held in memory keyed by session id.

import { chatDeepSeekTool, chatDeepSeekToolStream } from "./deepseek";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";

// ── Types ──

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  /** DeepSeek reasoning_content that must be passed back in subsequent requests. */
  reasoning_content?: string;
}

export interface AgentState {
  messages: AgentMessage[];
  iteration: number;
  projectRoot: string;
  pendingPermission?: { toolCallId: string; command: string; background?: boolean };
  /** True once the API has returned reasoning_content in any response. */
  isReasoningModel?: boolean;
}

export interface AgentResponse {
  phase: "done" | "tool_needed";
  /** When phase=done: the final text reply. */
  reply?: string;
  /** When phase=tool_needed: what tool the server needs the renderer to run. */
  tool?: { name: string; id: string; params: Record<string, unknown> };
  /** When phase=tool_needed: tools the server already executed (for UI display). */
  executedTools?: { name: string; result: string }[];
  /** Full message history (needed for /continue). */
  messages?: AgentMessage[];
}

// ── SSE event types for streaming agent ──

export interface AgentSseEvent {
  type: "thinking" | "text" | "tool_start" | "tool_end" | "browser_tool" | "permission_required" | "done" | "error" | "warning";
  /** Chunk of thinking/reasoning text. */
  text?: string;
  /** Tool name (on tool_start / tool_end / browser_tool). */
  toolName?: string;
  /** Tool params (on tool_start / browser_tool). */
  toolParams?: Record<string, unknown>;
  /** Original file content before write (on tool_start for write_file). */
  originalContent?: string | null;
  /** Tool call ID (on browser_tool / permission_required, for /continue). */
  toolCallId?: string;
  /** Tool result text (on tool_end). */
  toolResult?: string;
  /** For run_command results: show as sandbox terminal output. */
  toolSandbox?: string;
  /** All tools executed in this round (on tool_end). */
  executedTools?: { name: string; result: string }[];
  /** Final reply text (on done). */
  reply?: string;
  /** Session ID (on browser_tool, for /continue). */
  sessionId?: string;
  /** Error message (on error). */
  error?: string;
  /** Warning message (on warning — shown to user as a system notice). */
  warning?: string;
  /** Usage stats (on done). */
  usage?: { estimatedTokens: number; contextLimit: number; turns: number };
  /** The shell command that needs permission (on permission_required). */
  permissionCommand?: string;
  /** Whether background=true was set (on permission_required, for /continue). */
  backgroundPerm?: boolean;
}

// ── Tool registry ──

const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a file or list a directory's contents. Returns the file text with line numbers, "
      + "or a directory listing showing files and subdirectories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file relative to the project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the project. Provide the relative path and the full new content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to project root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories at a given project path. Returns names and types.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to project root (use '.' for root)." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Recursively search the project for files or folders matching a name pattern. "
      + "Returns relative paths. Use this to find any file or folder in the project.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Substring to match in file/directory names (case-insensitive)." },
        subdir: { type: "string", description: "Optional subdirectory to search within (defaults to project root)." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents for a regex pattern across the project. "
      + "Returns file paths, line numbers, and matching lines. "
      + "Use this to find where a function, class, variable, or string is used.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex or literal string to search for in file contents (case-insensitive)." },
        subdir: { type: "string", description: "Optional subdirectory to search within (defaults to project root)." },
        glob: { type: "string", description: "Optional file pattern to filter (e.g. '*.ts', '*.js')." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in a sandbox and return stdout + stderr. "
      + "Fast, no terminal tab, no user permission needed. "
      + "The working directory is already the project root — do NOT use cd/pushd. "
      + "Use for: tests, lint, git, installing packages, building, grep, etc. "
      + "For starting servers or long-running apps use run_in_terminal instead.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
    },
  },
  {
    name: "run_in_terminal",
    description:
      "Run a long-running command in a real terminal tab. "
      + "User must Allow each command. The command runs in the background — you can continue working immediately. "
      + "Output streams to the terminal card and the terminal tab. "
      + "Use for: starting servers (python app.py, npm start, flask run), watching builds, interactive shells. "
      + "For short commands (tests, git, install, lint) use run_command instead.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
    },
  },
  {
    name: "create_directory",
    description:
      "Create a new directory (and any parent directories as needed). Returns confirmation.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file or directory (recursively). Use with caution — this is permanent. "
      + "Returns confirmation or an error message.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory relative to project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_file",
    description:
      "Rename or move a file or directory. Provide the current path and the new path. "
      + "Returns confirmation or an error message.",
    parameters: {
      type: "object",
      properties: {
        oldPath: { type: "string", description: "Current path to the file or directory relative to project root." },
        newPath: { type: "string", description: "New path (and name) for the file or directory." },
      },
      required: ["oldPath", "newPath"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the current browser page and return it as a base64 PNG. "
      + "Use this to 'see' what is currently displayed in the browser preview.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_get_dom",
    description:
      "Get the current page's DOM as a list of indexed, clickable/typable elements. "
      + "Use this before click/type to find the right element index.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_click",
    description: "Click the DOM element at the given index (from browser_get_dom).",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index from browser_get_dom." },
      },
      required: ["index"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into the input element at the given index.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index from browser_get_dom." },
        text: { type: "string", description: "Text to type." },
      },
      required: ["index", "text"],
    },
  },
  {
    name: "browser_eval",
    description:
      "Run arbitrary JavaScript in the browser page and return the result. "
      + "Use to read page state, check element properties, or interact with the page programmatically.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to run in the page." },
      },
      required: ["code"],
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate the browser to a new URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to." },
      },
      required: ["url"],
    },
  },
  {
    name: "task_complete",
    description:
      "Call this when you have finished the user's request. Provide a summary of what you did and any findings.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of what was done and what was found." },
      },
      required: ["summary"],
    },
  },
  {
    name: "write_todos",
    description:
      "Create or update a structured task list to track your progress. "
      + "Call this before starting work to break down complex requests into steps. "
      + "Update as you complete items. The todos are displayed in the UI.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full task list. Each item has id, text, and status (pending, in_progress, completed, or cancelled).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier for the todo (e.g. '1', '2')." },
              text: { type: "string", description: "The task description." },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "Current status of the task." },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ── Tool execution ──

export type ToolExecutor = (
  name: string,
  params: Record<string, unknown>,
  projectRoot: string
) => Promise<{ result: string; skipRenderer?: boolean }>;

// Filesystem tools that the server can execute directly.

async function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const MAX_KEEP = 4000;
    const HARD_TIMEOUT_MS = 45000;
    const IDLE_TIMEOUT_MS = 2000; // resolve early if output stops for this long
    let buf = "";
    let totalChars = 0;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const proc = spawn(command, [], {
      cwd,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (code: number | null) => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const out = buf.trimEnd();
      let prefix = "";
      if (totalChars > MAX_KEEP) {
        prefix = `... (showing last ${MAX_KEEP} of ${totalChars} chars)\n`;
      }
      if (timedOut) {
        prefix += `[Command timed out after ${HARD_TIMEOUT_MS / 1000}s]\n`;
      }
      const result = prefix + (out || "(command completed with no output)");
      if (code !== 0 && code !== null && !timedOut) {
        resolve(`Exit code ${code}: ${result}`.slice(0, 4400));
      } else {
        resolve(result);
      }
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      const isWin = process.platform === "win32";
      proc.kill(isWin ? undefined : "SIGKILL");
    }, HARD_TIMEOUT_MS);

    // Start idle timer immediately — if no output at all within IDLE_TIMEOUT_MS, resolve.
    // Each output chunk resets this timer, so continuous output extends it indefinitely.
    idleTimer = setTimeout(() => {
      const isWin = process.platform === "win32";
      proc.kill(isWin ? undefined : "SIGKILL");
    }, IDLE_TIMEOUT_MS);

    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      totalChars += text.length;
      buf = (buf + text).slice(-MAX_KEEP);
      // Reset idle timer — if output stops for IDLE_TIMEOUT_MS, resolve early
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const isWin = process.platform === "win32";
        proc.kill(isWin ? undefined : "SIGKILL");
      }, IDLE_TIMEOUT_MS);
    };

    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);

    proc.on("close", (code) => {
      clearTimeout(hardTimer);
      finish(code);
    });

    proc.on("error", (err) => {
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve(`Failed to spawn: ${err.message}`);
    });
  });
}

export async function runFsTool(name: string, params: Record<string, unknown>, root: string): Promise<string | null> {
  const resolve = (p: string) => path.resolve(root, p);
  if (name === "read_file") {
    const filePath = resolve(String(params.path || ""));
    if (!fs.existsSync(filePath)) return `File not found: ${params.path}`;
    if (fs.statSync(filePath).isDirectory()) {
      const entries = fs.readdirSync(filePath, { withFileTypes: true });
      const listing = entries
        .filter((e) => e.name !== "node_modules" && e.name !== ".git" && !e.name.startsWith("."))
        .map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`)
        .join("\n");
      return `Directory listing for ${params.path}:\n${listing || "(empty)"}`;
    }
    const text = fs.readFileSync(filePath, "utf-8");
    const lines = text.split("\n");
    const numbered = lines.map((l, i) => `${String(i + 1).padStart(4, " ")}| ${l}`).join("\n");
    const truncated = text.length > 20000 ? numbered.slice(0, 20000) + "\n... (file truncated)" : numbered;
    return truncated;
  }
  if (name === "write_file") {
    const filePath = resolve(String(params.path || ""));
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, String(params.content || ""), "utf-8");
    return `Wrote ${fs.statSync(filePath).size} bytes to ${params.path}.`;
  }
  if (name === "list_files") {
    const dirPath = resolve(String(params.path || "."));
    if (!fs.existsSync(dirPath)) return `Directory not found: ${params.path}`;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== "node_modules" && e.name !== ".git")
      .map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
      .join("\n");
  }
  if (name === "search_files") {
    const base = resolve(String(params.subdir || "."));
    if (!fs.existsSync(base)) return `Directory not found: ${params.subdir || "."}`;
    const pattern = String(params.pattern || "").toLowerCase();
    if (!pattern) return "Provide a non-empty pattern.";
    const results: string[] = [];
    const MAX_RESULTS = 80;
    function walk(dir: string) {
      if (results.length >= MAX_RESULTS) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(pattern)) {
          results.push(path.relative(root, full).replace(/\\/g, "/") + (e.isDirectory() ? "/" : ""));
          if (results.length >= MAX_RESULTS) return;
        }
        if (e.isDirectory()) walk(full);
      }
    }
    walk(base);
    if (results.length === 0) return `No files or folders matching "${params.pattern}" found.`;
    return results.join("\n") + (results.length >= MAX_RESULTS ? `\n... (truncated at ${MAX_RESULTS} results)` : "");
  }
  if (name === "grep") {
    const base = resolve(String(params.subdir || "."));
    if (!fs.existsSync(base)) return `Directory not found: ${params.subdir || "."}`;
    const rawPattern = String(params.pattern || "");
    if (!rawPattern) return "Provide a non-empty pattern.";
    let regex: RegExp;
    try { regex = new RegExp(rawPattern, "gi"); } catch { regex = new RegExp(rawPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); }
    const globStr = String(params.glob || "");
    const results: string[] = [];
    const MAX_MATCHES = 80;
    function walk(dir: string) {
      if (results.length >= MAX_MATCHES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        // glob filter
        if (globStr) {
          const ext = path.extname(e.name).toLowerCase();
          const g = globStr.toLowerCase();
          if (g.startsWith("*.")) { if (ext !== g.slice(1)) continue; }
          else if (g.startsWith(".")) { if (ext !== g) continue; }
          else if (!e.name.toLowerCase().includes(g)) continue;
        }
        try {
          const text = fs.readFileSync(full, "utf-8");
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              regex.lastIndex = 0; // reset after test
              const rel = path.relative(root, full).replace(/\\/g, "/");
              results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
              if (results.length >= MAX_MATCHES) return;
            }
          }
        } catch { /* binary / unreadable */ }
      }
    }
    walk(base);
    if (results.length === 0) return `No matches for "${rawPattern}" found.`;
    return results.join("\n") + (results.length >= MAX_MATCHES ? `\n... (truncated at ${MAX_MATCHES} results)` : "");
  }
  if (name === "run_command") {
    return await runCommand(String(params.command || ""), root);
  }
  if (name === "create_directory") {
    const dirPath = resolve(String(params.path || ""));
    fs.mkdirSync(dirPath, { recursive: true });
    return `Created directory: ${params.path}`;
  }
  if (name === "delete_file") {
    const targetPath = resolve(String(params.path || ""));
    if (!fs.existsSync(targetPath)) return `Not found: ${params.path}`;
    // Retry on Windows lock errors (antivirus, editor holding handle, etc.)
    const delays = [0, 60, 150, 300, 600];
    let lastErr: any;
    for (const wait of delays) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        if (fs.statSync(targetPath).isDirectory()) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(targetPath);
        }
        return `Deleted: ${params.path}`;
      } catch (err: any) {
        lastErr = err;
        const code = err?.code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
        if ((code === "EPERM" || code === "EACCES") && fs.existsSync(targetPath)) {
          try { fs.chmodSync(targetPath, 0o666); } catch { /* */ }
        }
      }
    }
    throw lastErr;
  }
  if (name === "rename_file") {
    const from = resolve(String(params.oldPath || ""));
    const to = resolve(String(params.newPath || ""));
    if (!fs.existsSync(from)) return `Not found: ${params.oldPath}`;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return `Renamed ${params.oldPath} to ${params.newPath}.`;
  }
  if (name === "write_todos") {
    const todos = params.todos;
    if (!Array.isArray(todos)) return "Error: todos must be an array.";
    return `Todos updated (${todos.length} items).`;
  }
  return null; // not a filesystem tool
}

// ── Agent loop ──

const MAX_ITERATIONS = 15;

const SYSTEM_PROMPT = `You are an expert software developer agent running inside a web IDE called Harness.
You have access to tools that let you read/write files, run commands, interact with a browser preview, and inspect the current page.

### Rules
1. Break the user's request into steps. Use \`write_todos\` to plan and track progress.
2. Use tools one at a time. After each tool call, read the result before deciding the next step.
3. When you are done, call \`task_complete\` with a summary.
4. If you encounter an error, explain what happened and suggest how to fix it.
5. Keep responses concise — one sentence of reasoning, one tool call.
6. Do NOT guess browser DOM indices — call \`browser_get_dom\` first.

### File conventions
- All file paths are relative to the project root.
- Use \`read_file\` to see existing code before editing it.
- Use \`write_file\` to create or overwrite a file.
- Use \`list_files\` to browse a specific directory.
- Use \`search_files\` to find any file or folder anywhere in the project (by name pattern).
- Use \`grep\` to search file contents for a string or regex — find definitions, usages, references.

### Browser usage
- Use \`browser_navigate\` to go to a URL.
- Use \`browser_screenshot\` when you need to see the page.
- Use \`browser_get_dom\` to get clickable element indices, then \`browser_click\` or \`browser_type\`.
- Use \`browser_eval\` to inspect page state programmatically.

### Terminal
- Use \`run_command\` for sandboxed short commands: tests, lint, git, pip, npm, builds, etc. (no permission needed, fast inline output).
- Use \`run_in_terminal\` for long-running commands: starting servers (python app.py, npm start), watch mode, interactive shells. User must Allow, command runs in background.
- The working directory is already the project root — do NOT use cd/pushd.

Current time: ${new Date().toISOString()}
`;

let callSeq = 0;

export async function agentLoop(
  projectRoot: string,
  state: AgentState,
  context: string,
  modelOpts?: { model?: string; apiKey?: string },
): Promise<AgentResponse> {
  const apiKey = modelOpts?.apiKey;
  if (!apiKey) {
    return { phase: "done", reply: "No API key configured. Set an API key in the Harness UI." };
  }
  state.iteration++;

  if (state.iteration > MAX_ITERATIONS) {
    const summary = "I've reached the maximum number of steps. " + 
      "Here's a summary of what I've done so far based on the previous tool results.";
    state.messages.push({ role: "assistant", content: summary });
    return { phase: "done", reply: summary, messages: state.messages };
  }

  const rc2 = (reasoning: string | null | undefined) =>
    (reasoning || state.isReasoningModel) ? { reasoning_content: reasoning || "" } : {};

  const systemMsg = context
    ? SYSTEM_PROMPT + `\n\n### Additional context from the IDE\n${context}`
    : SYSTEM_PROMPT;

  const openaiMessages: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: any[]; reasoning_content?: string }> = [];
  // Push a system message
  openaiMessages.push({ role: "system", content: systemMsg });
  let hasToolCalls = false; // guard: ensure tool msgs only follow assistant with tool_calls

  for (const m of state.messages) {
    if (m.role === "tool") {
      if (!hasToolCalls) continue; // skip orphaned tool message
      hasToolCalls = false;
      openaiMessages.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.tool_call_id,
      });
    } else if (m.role === "assistant" && m.name) {
      // assistant message with tool_calls (reconstruct from stored JSON)
      try {
        const calls = JSON.parse(m.content);
        openaiMessages.push({
          role: "assistant",
          content: null,
          tool_calls: calls,
          ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}),
        });
        hasToolCalls = true;
      } catch {
        openaiMessages.push({ role: "assistant", content: m.content, ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}) });
      }
    } else {
      hasToolCalls = false;
      openaiMessages.push(m);
    }
  }

  const { text, toolCalls, reasoningContent } = await chatDeepSeekTool(openaiMessages, TOOLS, { model: modelOpts?.model, apiKey });
  if (reasoningContent != null) state.isReasoningModel = true;

  if (toolCalls && toolCalls.length > 0) {
    const executedTools: { name: string; result: string }[] = [];
    let browserTool: { name: string; id: string; params: Record<string, unknown> } | null = null;

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      // Capture original content before write_file / delete_file for undo support
      let originalContent: string | null = null;
      if (fnName === "write_file" || fnName === "delete_file") {
        const targetPath = path.resolve(projectRoot, String(params.path || ""));
        try { originalContent = fs.readFileSync(targetPath, "utf-8"); } catch { originalContent = null; }
      }

      // Check if this is a filesystem tool the server can execute directly.
      const fsResult = await runFsTool(fnName, params, projectRoot);
      if (fsResult !== null) {
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: fsResult, tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: fsResult.slice(0, 1000) });
        continue;
      }

      // task_complete ends the loop.
      if (fnName === "task_complete") {
        const summary = String(params.summary || "Task completed.");
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: "OK", tool_call_id: tc.id });
        return { phase: "done", reply: summary, messages: state.messages, executedTools };
      }

      // Browser tool — needs the renderer to execute it.
      browserTool = { name: fnName, id: tc.id, params };
      state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
      break; // only one browser tool per round
    }

    if (browserTool) {
      return { phase: "tool_needed", tool: browserTool, executedTools, messages: state.messages };
    }

    // If we executed filesystem tools but no browser tool, continue the loop.
    return agentLoop(projectRoot, state, "");
  }

  // No tool calls — final text reply.
  if (text) {
    state.messages.push({ role: "assistant", content: text, ...rc2(reasoningContent) });
  }
  return { phase: "done", reply: text || "Task completed.", messages: state.messages };
}

// ── Streaming agent loop ──
// Async generator that yields AgentSseEvent objects.
// The caller (SSE endpoint) serializes them as `data: <json>\n\n`.

export async function* agentLoopStream(
  projectRoot: string,
  state: AgentState,
  context: string,
  sessionId: string,
  modelOpts?: { model?: string; apiKey?: string },
): AsyncGenerator<AgentSseEvent> {
  const apiKey = modelOpts?.apiKey;
  if (!apiKey) {
    yield { type: "error", error: "No API key configured. Set an API key in the Harness UI." };
    return;
  }
  const MAX_ITERS = 50;
  const systemMsg = context
    ? SYSTEM_PROMPT + `\n\n### Additional context from the IDE\n${context}`
    : SYSTEM_PROMPT;

  const buildMessages = () => {
    const msgs: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: any[]; reasoning_content?: string }> = [];
    msgs.push({ role: "system", content: systemMsg });
    let hasToolCalls = false; // guard: ensure tool msgs only follow assistant with tool_calls
    for (const m of state.messages) {
      if (m.role === "tool") {
        if (!hasToolCalls) continue; // skip orphaned tool message — no preceding assistant with tool_calls
        hasToolCalls = false;
        msgs.push({ role: "tool", content: m.content, tool_call_id: m.tool_call_id });
      } else if (m.role === "assistant" && m.name) {
        try {
          const calls = JSON.parse(m.content);
          msgs.push({ role: "assistant", content: null, tool_calls: calls, ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}) });
          hasToolCalls = true;
        } catch {
          msgs.push({ role: "assistant", content: m.content, ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}) });
        }
      } else {
        hasToolCalls = false;
        msgs.push(m);
      }
    }
    return msgs;
  };

  // Track whether we've already warned about history length
  // (only warn once per session to avoid spam).
  let turnsWarned = false;
  let finalEstTokens = 0;

  const makeUsage = (turns: number) => ({
    estimatedTokens: finalEstTokens,
    contextLimit: 1_000_000,
    turns,
  });

  // ── Helper: attach reasoning_content if this is a reasoning model ──
  const rc = (reasoning: string | null | undefined) =>
    (reasoning || state.isReasoningModel) ? { reasoning_content: reasoning || "" } : {};

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    state.iteration++;
    const openaiMessages = buildMessages();

    // ── Heuristic warnings ──
    // Estimate token count: ~4 chars per token for English text.
    const totalChars = state.messages.reduce((sum, m) => sum + (m.content?.length || 0) + (m.tool_call_id?.length || 0) + (m.name?.length || 0), 0);
    const estTokens = Math.round(totalChars / 4);
    finalEstTokens = estTokens;

    // Warn when approaching the iteration limit.
    if (!turnsWarned && iter >= 20) {
      turnsWarned = true;
      yield {
        type: "warning",
        warning: `${iter + 1}/${MAX_ITERS} turns used. If the task hasn't completed soon, try breaking it into smaller steps.`,
      };
    }

    // Stream response from DeepSeek
    const stream = chatDeepSeekToolStream(openaiMessages, TOOLS, { model: modelOpts?.model, apiKey });
    let streamDone = false;
    let finalText: string | null = null;
    let finalReasoning: string | null = null;
    let finalToolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | null = null;

    for await (const chunk of stream) {
      if (chunk.type === "thinking") {
        yield { type: "thinking", text: chunk.text };
      } else if (chunk.type === "text") {
        yield { type: "text", text: chunk.text };
      } else if (chunk.type === "done") {
        finalText = chunk.finalText ?? null;
        finalReasoning = chunk.reasoningContent ?? null;
        if (chunk.reasoningContent != null) state.isReasoningModel = true;
        finalToolCalls = chunk.toolCalls ?? null;
        streamDone = true;
      }
    }

    if (!streamDone) {
      yield { type: "error", error: "Stream interrupted" };
      return;
    }

    // No tool calls — assistant text reply. Push it and continue the loop
    // so the agent can keep working if it has more to say.
    if (!finalToolCalls || finalToolCalls.length === 0) {
      const reply = finalText || "OK.";
      state.messages.push({ role: "assistant", content: reply, ...rc(finalReasoning) });
      yield { type: "text", text: reply };
      // Don't end here — the agent may call tools next iteration
      continue;
    }

    // Process tool calls
    const executedTools: { name: string; result: string }[] = [];
    let browserTool: { name: string; id: string; params: Record<string, unknown> } | null = null;

    for (const tc of finalToolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      // run_command: sandboxed — execute directly, no permission needed
      if (fnName === "run_command") {
        const cmd = String(params.command || "");
        // Yield tool_start immediately so the client shows the spinner
        yield { type: "tool_start", toolName: fnName, toolParams: params };
        // Then run the command (client sees "Wait a moment..." while this runs)
        const fsResult = await runFsTool(fnName, params, projectRoot);
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: fsResult || "", tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: "Command completed",
          toolSandbox: fsResult || "",
          executedTools: [{ name: fnName, result: (fsResult || "").slice(0, 500) }],
        };
        executedTools.push({ name: fnName, result: (fsResult || "").slice(0, 1000) });
        continue;
      }

      // run_in_terminal: requires user permission (opens real terminal tab)
      if (fnName === "run_in_terminal") {
        const cmd = String(params.command || "");
        // Add assistant tool_calls message for ALL remaining tools in this round.
        // DeepSeek requires a tool response for every tool_call_id — push null responses
        // for tools that will be handled after /continue (or dropped).
        const allToolCalls = finalToolCalls.map((t) => ({
          id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments },
        }));
        state.messages.push({ role: "assistant", content: JSON.stringify(allToolCalls), name: fnName, ...rc(finalReasoning) });
        // For tools that won't execute now (run_in_terminal pauses, others dropped),
        // push dummy tool results so DeepSeek doesn't complain about missing responses.
        // The actual terminal tool result will be pushed by /stream/continue.
        for (const t of finalToolCalls.slice(1)) {
          state.messages.push({ role: "tool", content: "Deferred.", tool_call_id: t.id });
        }
        // Store the pending command so /continue can execute it after user approval
        state.pendingPermission = { toolCallId: tc.id, command: cmd, background: true };
        yield { type: "tool_start", toolName: fnName, toolParams: params };
        yield {
          type: "permission_required",
          toolCallId: tc.id,
          toolName: fnName,
          permissionCommand: cmd,
          backgroundPerm: true,
          executedTools,
        };
        return;
      }

      // Filesystem tool — execute directly
      // For write_file and delete_file, capture original content before the operation
      let originalContent: string | null = null;
      if (fnName === "write_file" || fnName === "delete_file") {
        const targetPath = path.resolve(projectRoot, String(params.path || ""));
        try { originalContent = fs.readFileSync(targetPath, "utf-8"); } catch { originalContent = null; }
      }
      const fsResult = await runFsTool(fnName, params, projectRoot);
      if (fsResult !== null) {
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: fsResult, tool_call_id: tc.id });
        const isCmd = fnName === "run_command";
        yield {
          type: "tool_start", toolName: fnName, toolParams: params,
          ...(originalContent !== null ? { originalContent } : {}),
        };
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: isCmd ? `Command completed` : fsResult.slice(0, 2000),
          toolSandbox: isCmd ? fsResult : undefined,
          executedTools: [{ name: fnName, result: fsResult.slice(0, 500) }],
        };
        executedTools.push({ name: fnName, result: fsResult.slice(0, 1000) });
        continue;
      }

      // task_complete
      if (fnName === "task_complete") {
        const summary = String(params.summary || "Task completed.");
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: "OK", tool_call_id: tc.id });
        yield { type: "done", reply: summary, usage: makeUsage(iter + 1) };
        return;
      }

      // Browser tool
      browserTool = { name: fnName, id: tc.id, params };
      state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
      break;
    }

    if (browserTool) {
      // Yield browser_tool and stop — caller resumes via /continue/stream
      yield {
        type: "browser_tool",
        toolName: browserTool.name,
        toolParams: browserTool.params,
        toolCallId: browserTool.id,
        sessionId,
        executedTools,
      };
      return;
    }

    // No browser tool but executed fs tools — continue the loop
  }

  yield {
    type: "warning",
    warning: `Reached the maximum of ${MAX_ITERS} turns. Start a "New Task" to continue with a fresh context.`,
  };
  yield { type: "done", reply: "Reached maximum iterations.", usage: makeUsage(MAX_ITERS) };
}

// Helper to add a tool result and get state for continuation
export function addToolResultStream(sessionId: string, toolCallId: string, result: string): AgentState | undefined {
  const session = agentSessions.get(sessionId);
  if (!session) return undefined;
  session.messages.push({ role: "tool", content: result, tool_call_id: toolCallId });
  return session;
}

export function deleteAgentSession(sessionId: string): boolean {
  return agentSessions.delete(sessionId);
}

// ── Session management ──

const agentSessions = new Map<string, AgentState>();

export function createAgentSession(sessionId: string, projectRoot: string, userMessage: string, context: string): AgentState {
  const state: AgentState = {
    messages: [
      { role: "user", content: userMessage },
    ],
    iteration: 0,
    projectRoot,
  };
  agentSessions.set(sessionId, state);
  return state;
}

export function getAgentSession(sessionId: string): AgentState | undefined {
  return agentSessions.get(sessionId);
}

export function addToolResult(sessionId: string, toolCallId: string, result: string): void {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  session.messages.push({ role: "tool", content: result, tool_call_id: toolCallId });
}
