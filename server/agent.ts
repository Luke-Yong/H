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
  pendingPermission?: { toolCallId: string; command: string; background?: boolean; toolName?: string };
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
    name: "edit_file",
    description:
      "Make a targeted edit to a file by replacing one string with another. "
      + "Much cheaper than write_file — only send the lines that change. "
      + "old_string must match exactly (including whitespace/indentation) and be unique in the file "
      + "(unless replace_all is true). The replacement is applied inline.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to project root." },
        old_string: { type: "string", description: "Exact text to find and replace. Must match exactly." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace all occurrences (default false)." },
      },
      required: ["path", "old_string", "new_string"],
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
      + "For short commands (tests, git, install, lint) use run_command instead. "
      + "After starting a web server: the terminal may detect URL output and auto-open a browser tab. "
      + "After the user Allows the command, wait a moment and call \`browser_info\` to check if a tab opened. "
      + "If no tab opened, ask the user to check the terminal output for the server URL — do NOT guess the port.",
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
      "Get a text snapshot of the current page: URL, title, visible text content, form inputs, buttons/links, "
      + "and any visible error messages. Use this instead of a visual screenshot — DeepSeek is text-only "
      + "so the snapshot returns readable text rather than an image.",
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
    description:
      "Click at viewport pixel coordinates (x, y) OR by DOM element index. "
      + "When using x,y: call browser_get_dom first to find coordinates. "
      + "When using index: element center is computed from its bounding rect automatically. "
      + "Dispatches full pointer/mouse event sequence (pointerdown, mousedown, pointerup, mouseup, click).",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X pixel coordinate in the viewport (use with y)." },
        y: { type: "integer", description: "Y pixel coordinate in the viewport (use with x)." },
        index: { type: "integer", description: "Or: DOM element index from browser_get_dom." },
      },
      required: [],
    },
  },
  {
    name: "browser_move_mouse",
    description:
      "Move the mouse cursor to viewport coordinates (x, y) without clicking. "
      + "Triggers mousemove/pointermove events. Use before browser_click or browser_right_click "
      + "to simulate natural hover-then-click behavior. Also useful for hover-dependent UI.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X pixel coordinate in the viewport." },
        y: { type: "integer", description: "Y pixel coordinate in the viewport." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "browser_right_click",
    description:
      "Right-click at viewport coordinates (x, y). "
      + "Dispatches a contextmenu event. Use to open context menus.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X pixel coordinate in the viewport." },
        y: { type: "integer", description: "Y pixel coordinate in the viewport." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the page by a pixel amount, or scroll to top/bottom. "
      + "Use this to reveal content below the fold, trigger lazy loading, or check the full page.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal scroll pixels (default 0)." },
        y: { type: "number", description: "Vertical scroll pixels (positive = down, negative = up)." },
        to: { type: "string", description: "Or: 'top' or 'bottom' to scroll to page extremes." },
      },
      required: [],
    },
  },
  {
    name: "browser_press_key",
    description:
      "Press a keyboard key on the page. "
      + "Dispatches keydown, keypress, and keyup events. "
      + "Common keys: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete, Space. "
      + "Use for submitting forms (Enter), closing modals (Escape), navigating lists (Arrow keys).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown')." },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Set files on an <input type=\"file\"> element at the given DOM index. "
      + "Provide one or more absolute file paths. "
      + "Dispatches the change event so the page detects the upload.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index from browser_get_dom (must be an <input type='file'>)." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to attach to the file input.",
        },
      },
      required: ["index", "paths"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into the input element at the given index. "
      + "Clears the current value first, then types each character with realistic keyboard events.",
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
    name: "browser_clear",
    description:
      "Clear the value of an input element at the given DOM index. "
      + "Use this before browser_type if you need to replace existing content, "
      + "or to clear a field without typing new text. "
      + "Dispatches input and change events so reactive frameworks detect the change.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index from browser_get_dom." },
      },
      required: ["index"],
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
    description: "Navigate the browser to a new URL. "
      + "Before navigating, call \`browser_info\` to check if the page is already open. "
      + "After starting a server with \`run_in_terminal\`, use \`browser_info\` first — the terminal may have already opened a tab at the correct URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_wait",
    description:
      "Wait for an element matching a CSS selector to appear on the page. "
      + "Polls every 200ms until the element is found or the timeout expires. "
      + "Returns the element details or 'NOT_FOUND'. Use this before clicking/typing "
      + "to avoid race conditions on dynamic pages.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (e.g. '.result', '#submit-btn', 'ul li:first-child')." },
        timeoutMs: { type: "integer", description: "Timeout in milliseconds (default: 5000)." },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_console",
    description:
      "Get the last 50 console entries (log, warn, error, dialog) from the page. "
      + "Use this to check for JavaScript errors, warnings, or debug output. "
      + "Also captures alert/confirm/prompt dialogs as [DIALOG] entries. "
      + "Returns one entry per line in [LEVEL] text format.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_select",
    description:
      "Select an option from a <select> dropdown at the given element index. "
      + "Set value by string (the option's value attribute), or by visible label text. "
      + "Triggers the 'change' event after selecting.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "Element index (from browser_get_dom)." },
        value: { type: "string", description: "The value attribute of the option to select." },
        label: { type: "string", description: "Or: the visible text label of the option to select." },
      },
      required: ["index"],
    },
  },
  {
    name: "browser_request_errors",
    description:
      "Get failed network requests (HTTP 4xx, 5xx, CORS errors) from the page. "
      + "Returns one entry per line in [status] method url format. "
      + "Captures both fetch/XHR and resource loads (images, scripts, etc). "
      + "Use this to verify API calls succeeded and no resources failed to load.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_info",
    description:
      "Get the current browser tab URL and page load status. "
      + "Use this to check which URL is currently loaded before navigating or interacting.",
    parameters: { type: "object", properties: {}, required: [] },
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
  {
    name: "read_problems",
    description:
      "Read the current IDE diagnostic problems (errors, warnings, hints) for all files. "
      + "Returns linter errors, TypeScript errors, etc. Use this after making changes to verify "
      + "that no new errors were introduced and existing problems were resolved.",
    parameters: { type: "object", properties: {}, required: [] },
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

    // Strip secrets from environment before passing to child process
    const safeEnv: Record<string, string> = {};
    for (const k of Object.keys(process.env)) {
      const upper = k.toUpperCase();
      if (
        upper.includes("KEY") || upper.includes("SECRET") || upper.includes("TOKEN") ||
        upper.includes("PASSWORD") || upper.includes("PASSWD") || upper.includes("CREDENTIAL") ||
        upper === "DOTENV_CONFIG_PATH" ||
        k.startsWith("npm_") || k.startsWith("NPM_")
      ) {
        continue; // skip secret keys
      }
      if (process.env[k] != null) safeEnv[k] = process.env[k];
    }
    // Keep PATH-like vars, HOME, USER, etc. but not API keys
    safeEnv.PATH = process.env.PATH || "";
    safeEnv.HOME = process.env.HOME || process.env.USERPROFILE || "";
    safeEnv.USER = process.env.USER || process.env.USERNAME || "";
    safeEnv.TEMP = process.env.TEMP || process.env.TMP || "";
    safeEnv.TMP = process.env.TMP || process.env.TEMP || "";
    safeEnv.SHELL = process.env.SHELL || process.env.COMSPEC || "";
    safeEnv.SYSTEMROOT = process.env.SYSTEMROOT || "";
    safeEnv.LANG = process.env.LANG || "en_US.UTF-8";

    const proc = spawn(command, [], {
      cwd,
      env: safeEnv,
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

  // ── Secret-file guard ──
  // Refuse access to files likely to contain credentials or tokens.
  const SECRET_PATTERNS = [
    /\.env$/i, /\.env\..*$/i,                       // .env, .env.local, .env.production
    /credentials/i, /secret/i, /\.pem$/i,            // credentials.*, secret.*, .pem
    /\.key$/i, /\.p12$/i, /\.pfx$/i,                 // private keys, cert stores
    /config\/.*secret/i, /config\/.*key/i,            // config/*secret*, config/*key*
  ];
  const isSecretPath = (p: string): boolean => {
    const name = path.basename(p);
    const relative = path.relative(root, p);
    return SECRET_PATTERNS.some((re) => re.test(name) || re.test(relative));
  };

  if (name === "read_file") {
    const filePath = resolve(String(params.path || ""));
    if (isSecretPath(filePath)) return `Blocked: ${params.path} may contain secrets. Use environment variables or a dedicated secrets manager.`;
    if (!fs.existsSync(filePath)) return `File not found: ${params.path}`;
    if (fs.statSync(filePath).isDirectory()) {
      const entries = fs.readdirSync(filePath, { withFileTypes: true });
      const listing = entries
        .filter((e) => e.name !== "node_modules" && e.name !== ".git")
        .map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`)
        .join("\n");
      return `Directory listing for ${params.path}:\n${listing || "(empty)"}`;
    }
    const text = fs.readFileSync(filePath, "utf-8");
    const lines = text.split("\n");
    const start = Math.max(1, Number(params.offset) || 1) - 1; // 0-based
    const end = params.limit != null ? start + Number(params.limit) : lines.length;
    const slice = lines.slice(start, Math.min(end, lines.length));
    const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(4, " ")}| ${l}`).join("\n");
    const truncated = slice.length < lines.length - start
      ? numbered + `\n... (lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length})`
      : numbered;
    return truncated || "(empty)";
  }
  if (name === "write_file") {
    const filePath = resolve(String(params.path || ""));
    if (isSecretPath(filePath)) return `Blocked: ${params.path} may contain secrets.`;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const content = String(params.content || "");
    fs.writeFileSync(filePath, content, "utf-8");
    const tokens = Math.round(content.length / 4);
    return `Wrote ~${tokens} tokens to ${params.path}.`;
  }
  if (name === "edit_file") {
    const filePath = resolve(String(params.path || ""));
    if (isSecretPath(filePath)) return `Blocked: ${params.path} may contain secrets.`;
    if (!fs.existsSync(filePath)) return `File not found: ${params.path}`;
    const oldStr = String(params.old_string || "");
    const newStr = String(params.new_string || "");
    const replaceAll = Boolean(params.replace_all);
    if (!oldStr) return "old_string is required.";
    const original = fs.readFileSync(filePath, "utf-8");
    const count = (original.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    if (count === 0) return `old_string not found in ${params.path}.`;
    if (count > 1 && !replaceAll) {
      return `old_string matches ${count} locations in ${params.path}. Use replace_all: true to replace all, or use a more specific old_string to target exactly one match.`;
    }
    const result = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    fs.writeFileSync(filePath, result, "utf-8");
    const tokens = Math.round(newStr.length / 4);
    return replaceAll
      ? `Replaced ${count} occurrences (~${tokens} tokens each) in ${params.path}.`
      : `Replaced ~${tokens} tokens in ${params.path}.`;
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
        // Skip secret files
        if (isSecretPath(full)) continue;
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
    if (isSecretPath(targetPath)) return `Blocked: ${params.path} may contain secrets.`;
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
    if (isSecretPath(from)) return `Blocked: ${params.oldPath} may contain secrets.`;
    if (isSecretPath(to)) return `Blocked: ${params.newPath} may target a secret location.`;
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

const MAX_ITERATIONS = 50;

const SYSTEM_PROMPT = `You are an expert software developer agent running inside a web IDE called Harness.
You have access to tools that let you read/write files, run commands, interact with a browser preview, and inspect the current page.

### Rules
1. Break the user's request into steps. Use \`write_todos\` to plan and track progress.
2. Use tools one at a time. After each tool call, read the result before deciding the next step.
3. When you are done, call \`task_complete\` with a summary.
4. If you encounter an error, explain what happened and suggest how to fix it.
5. Keep responses concise — one sentence of reasoning, one tool call.
6. Do NOT guess browser DOM indices — call \`browser_get_dom\` first.
7. **Before interacting with a web app in the browser, you MUST start the server first.** Use \`run_in_terminal\` to start the server (e.g. \`python app.py\`, \`npm start\`), wait for the user to Allow the command, then call \`browser_info\` to check if a tab opened automatically. Do NOT try to navigate to localhost URLs before confirming the server is running.
8. After starting a server, do NOT guess the URL or port. Call \`browser_info\` to check if a tab opened. If none, ask the user for the URL.

### File conventions
- All file paths are relative to the project root.
- Use \`read_file\` to see existing code before editing it.
- Use \`write_file\` to create or overwrite a file with full content.
- Use \`edit_file\` for targeted edits — provide old_string (exact text to replace) and new_string. Much cheaper than write_file; only send the lines that change. old_string must match exactly including whitespace/indentation. If it matches multiple locations, set replace_all to true or make it more specific.
- Use \`list_files\` to browse a specific directory.
- Use \`search_files\` to find any file or folder anywhere in the project (by name pattern).
- Use \`grep\` to search file contents for a string or regex — find definitions, usages, references.

### Browser usage
- Use \`browser_navigate\` to go to a URL.
- Use \`browser_info\` to check the current browser tab URL before navigating — avoid navigating to a URL that's already loaded.
- Use \`browser_wait\` to wait for an element to appear before interacting (avoid race conditions).
- Use \`browser_screenshot\` to see the page as a text snapshot (URL, title, visible text, form fields, buttons).
- Use \`browser_get_dom\` to get element positions as (x:NNN y:NNN WWWxHHH), then \`browser_click\`, \`browser_type\`, or \`browser_clear\`.
- To click: use \`browser_click index=N\` (easiest) or \`browser_click x=CX y=CY\`.
- To type or clear: use \`browser_click index=N\` FIRST, then \`browser_type index=N\` or \`browser_clear index=N\`. The click activates the input for reactive frameworks.
- To select: \`browser_select index=N value="v"\` — clicks the select first, then sets the value.
- Use \`browser_move_mouse\` to move cursor to x,y first (triggers hover effects), then \`browser_click\`.
- Use \`browser_clear\` to clear an input field before typing new text.
- Use \`browser_select\` to select an option from a <select> dropdown by value or visible label.
- Use \`browser_scroll\` to scroll the page (pixels or to top/bottom) — reveals lazy-loaded or off-screen content.
- Use \`browser_right_click\` to right-click at x,y — opens context menus.
- Use \`browser_press_key\` to press keyboard keys (Enter, Escape, Tab, arrows) — submits forms, closes modals, navigates.
- Use \`browser_upload_file\` to set files on a file input — provide absolute file paths.
- Use \`browser_eval\` to inspect page state programmatically.
- Use \`browser_console\` to check for JavaScript errors, alerts/confirms, or warnings.
- Use \`browser_request_errors\` to check for failed API calls or resource loads.

### Web element patterns
Use these patterns when encountering common UI elements:

**Text inputs**  
\`browser_click index=N\` → \`browser_type index=N text="value"\`  
If the field already has content: \`browser_clear index=N\` first.

**Dropdowns (\<select>)**  
\`browser_select index=N value="option_value"\` or \`browser_select index=N label="Visible Text"\`  
If options aren't populated yet, click first to trigger loading: \`browser_click index=N\` then \`browser_get_dom\`.

**Autocomplete / search inputs**  
Type partial text → wait → recheck DOM for dropdown options:  
\`browser_type index=N text="partial"\` → \`browser_wait selector=".autocomplete,.suggestion,.dropdown:not(.hidden),ul li:first-child"\` → \`browser_get_dom\` → \`browser_click index=M\` on the suggestion.

**Checkboxes / radio buttons / toggles**  
Click directly: \`browser_click index=N\`.  
To check state after: \`browser_eval code="document.querySelectorAll('input[type=checkbox],input[type=radio]')[N].checked"\`.

**Modals / dialogs**  
Wait for them: \`browser_wait selector=".modal,.dialog,.overlay:not([style*='display:none'])"\`.  
Close with: \`browser_press_key key="Escape"\` or click close button.

**Tooltips / hover menus**  
\`browser_move_mouse x=CX y=CY\` then \`browser_get_dom\` to see revealed elements.

**Lazy-loaded / infinite-scroll content**  
\`browser_scroll to="bottom"\` → \`browser_wait selector="new-element-selector"\` → \`browser_get_dom\`.

**File uploads**  
\`browser_upload_file index=N paths=["/absolute/path/to/file.pdf"]\`.

**If submits, navigations, or dialog triggers don't work** — use \`browser_eval\` to inspect the page state or trigger the action programmatically.

### Diagnostics
- Use \`read_problems\` to check the current IDE diagnostics — linter errors, TypeScript errors, warnings, hints. Call this after making file changes to verify no new errors were introduced.
- Use \`browser_console\` to inspect browser console output for runtime errors.
- Use \`browser_request_errors\` to check for failed network requests in the browser.
- Use \`run_command\` to run tests, linters, or build commands and read their output directly.

### Terminal
- Use \`run_command\` for sandboxed short commands: tests, lint, git, pip, npm, builds, etc. (no permission needed, fast inline output).
- Use \`run_in_terminal\` for long-running commands: starting servers (python app.py, npm start), watch mode, interactive shells. User must Allow, command runs in background.
- The working directory is already the project root — do NOT use cd/pushd.
- After starting a web server with \`run_in_terminal\`: wait for the user to Allow the command, then call \`browser_info\` to see if the terminal auto-opened a browser tab. If no tab is open, the server URL may not have been detected — ask the user for the URL instead of guessing the port (do NOT assume port 5000 or 8000).

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
  const pendingIds = new Set<string>(); // track all tool_call_ids waiting for a response

  for (const m of state.messages) {
    if (m.role === "tool") {
      const tid = m.tool_call_id;
      if (tid && pendingIds.has(tid)) {
        pendingIds.delete(tid);
        openaiMessages.push({ role: "tool", content: m.content, tool_call_id: tid });
      }
      // else: orphaned tool message (no matching assistant with tool_calls) — skip
    } else if (m.role === "assistant" && m.name) {
      // Flush any pending tool_call_ids before pushing a new assistant with tool_calls.
      // This maintains valid API ordering: assistant(tool_calls) → tool(response).
      for (const id of pendingIds) {
        openaiMessages.push({ role: "tool", content: "Deferred.", tool_call_id: id });
      }
      pendingIds.clear();

      // assistant message with tool_calls (reconstruct from stored JSON)
      try {
        const calls: Array<{ id?: string }> = JSON.parse(m.content);
        const ids = calls.map((c) => c.id).filter(Boolean) as string[];
        for (const id of ids) pendingIds.add(id);
        openaiMessages.push({
          role: "assistant",
          content: null,
          tool_calls: calls,
          ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}),
        });
      } catch {
        openaiMessages.push({ role: "assistant", content: m.content, ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}) });
      }
    } else {
      openaiMessages.push(m);
    }
  }
  // Auto-complete any tool_call_ids still waiting for a response.
  // This ensures the message sequence is always valid for the API.
  for (const id of pendingIds) {
    openaiMessages.push({ role: "tool", content: "Deferred.", tool_call_id: id });
  }

  const { text, toolCalls, reasoningContent } = await chatDeepSeekTool(openaiMessages, TOOLS, { model: modelOpts?.model, apiKey });
  if (reasoningContent != null) state.isReasoningModel = true;

  if (toolCalls && toolCalls.length > 0) {
    const executedTools: { name: string; result: string }[] = [];
    let browserTool: { name: string; id: string; params: Record<string, unknown> } | null = null;

    let browserBreakIdx = -1;
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
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
      browserBreakIdx = i;
      break;
    }

    if (browserTool) {
      // Push any remaining tool calls with "Deferred." responses so they aren't lost.
      // The actual result for the browser tool will be pushed by /continue.
      for (let i = browserBreakIdx + 1; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }]), name: tc.function.name, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: "Deferred.", tool_call_id: tc.id });
      }
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
    const pendingIds = new Set<string>(); // track all tool_call_ids waiting for a response
    for (const m of state.messages) {
      if (m.role === "tool") {
        const tid = m.tool_call_id;
        if (tid && pendingIds.has(tid)) {
          pendingIds.delete(tid);
          msgs.push({ role: "tool", content: m.content, tool_call_id: tid });
        }
        // else: orphaned tool message — skip
      } else if (m.role === "assistant" && m.name) {
        // Flush any pending tool_call_ids before pushing a new assistant with tool_calls.
        // This maintains valid API ordering: assistant(tool_calls) → tool(response).
        for (const id of pendingIds) {
          msgs.push({ role: "tool", content: "Deferred.", tool_call_id: id });
        }
        pendingIds.clear();

        try {
          const calls: Array<{ id?: string }> = JSON.parse(m.content);
          const ids = calls.map((c) => c.id).filter(Boolean) as string[];
          for (const id of ids) pendingIds.add(id);
          msgs.push({ role: "assistant", content: null, tool_calls: calls, ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}) });
        } catch {
          msgs.push({ role: "assistant", content: m.content, ...(m.reasoning_content || state.isReasoningModel ? { reasoning_content: m.reasoning_content || "" } : {}) });
        }
      } else {
        msgs.push(m);
      }
    }
    // Auto-complete any tool_call_ids still waiting for a response.
    // This ensures the message sequence is always valid for the API.
    for (const id of pendingIds) {
      msgs.push({ role: "tool", content: "Deferred.", tool_call_id: id });
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

    // No tool calls — assistant text reply. Push it and stop the loop.
    // The agent shouldn't keep generating text without tool calls — that
    // leads to infinite conversation loops where DeepSeek never stops.
    if (!finalToolCalls || finalToolCalls.length === 0) {
      const reply = finalText || "OK.";
      state.messages.push({ role: "assistant", content: reply, ...rc(finalReasoning) });
      yield { type: "text", text: reply };
      yield { type: "done", reply, usage: makeUsage(iter + 1) };
      return;
    }

    // Process tool calls
    const executedTools: { name: string; result: string }[] = [];
    let browserTool: { name: string; id: string; params: Record<string, unknown> } | null = null;
    let browserBreakIdx = -1;

    for (let i = 0; i < finalToolCalls.length; i++) {
      const tc = finalToolCalls[i];
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
        // Push individual assistant+tool messages for each tool call.
        // run_in_terminal pauses for permission — push "Deferred." for all
        // other tools so they don't block. The actual run_in_terminal result
        // will be pushed by /stream/continue.
        for (let i = 0; i < finalToolCalls.length; i++) {
          const t = finalToolCalls[i];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          if (i > 0) {
            state.messages.push({ role: "tool", content: "Deferred.", tool_call_id: t.id });
          }
        }
        // Store the pending command so /continue can execute it after user approval
        state.pendingPermission = { toolCallId: tc.id, command: cmd, background: true, toolName: "run_in_terminal" };
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

      // browser_eval: requires user permission (arbitrary JS execution risk)
      if (fnName === "browser_eval") {
        const code = String(params.code || "");
        // Push individual assistant+tool messages for each tool call.
        // browser_eval pauses for permission — push "Deferred." for all
        // other tools so they don't block. The actual eval result will be
        // pushed by /stream/continue.
        for (let i = 0; i < finalToolCalls.length; i++) {
          const t = finalToolCalls[i];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          if (i > 0) {
            state.messages.push({ role: "tool", content: "Deferred.", tool_call_id: t.id });
          }
        }
        state.pendingPermission = { toolCallId: tc.id, command: code, background: false, toolName: "browser_eval" };
        yield { type: "tool_start", toolName: fnName, toolParams: params };
        yield {
          type: "permission_required",
          toolCallId: tc.id,
          toolName: fnName,
          permissionCommand: code,
          backgroundPerm: false,
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
      // Yield tool_start immediately so the client shows the spinner before we await
      yield {
        type: "tool_start", toolName: fnName, toolParams: params,
        ...(originalContent !== null ? { originalContent } : {}),
      };
      const fsResult = await runFsTool(fnName, params, projectRoot);
      if (fsResult !== null) {
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: fsResult, tool_call_id: tc.id });
        const isCmd = fnName === "run_command";
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
      browserBreakIdx = i;
      break;
    }

    if (browserTool) {
      // Push any remaining tool calls with "Deferred." responses so they aren't lost.
      // The actual result for the browser tool will be pushed by /stream/continue.
      for (let i = browserBreakIdx + 1; i < finalToolCalls.length; i++) {
        const tc = finalToolCalls[i];
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }]), name: tc.function.name, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: "Deferred.", tool_call_id: tc.id });
      }
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
