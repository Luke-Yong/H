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
  /** Rolling summary of older resolved plain-text turns trimmed out of messages. */
  historySummary?: string;
  pendingPermission?: { toolCallId: string; command: string; background?: boolean; toolName?: string; params?: Record<string, unknown> };
  /** Deferred destructive file tool — executed on Allow, result held until Accept/Reject in UI. */
  deferredTool?: { toolCallId: string; toolName: string; params: Record<string, unknown>; result: string; originalContent: string | null; filePath: string };
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
      + "or a directory listing showing files and subdirectories. "
      + "For large files, use offset and limit to paginate — e.g. offset=100 limit=50 reads lines 100-149.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file relative to the project root." },
        offset: { type: "integer", description: "Line number to start reading from (1-based, default: 1)." },
        limit: { type: "integer", description: "Max lines to return (default: all lines)." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a NEW file or completely rewrite an existing file. Provide the relative path and the full new content. "
      + "IMPORTANT: PREFER edit_file for modifying existing files — only use write_file when creating a brand-new file or when the entire file content has changed. "
      + "write_file sends the whole file content which is wasteful for small changes.",
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
      "Run a short shell command in a sandbox and return stdout + stderr. "
      + "Fast, no terminal tab, no user permission needed. "
      + "The working directory is ALREADY the project root — NEVER use cd, pushd, or absolute paths like /workspace. "
      + "On Windows: use PowerShell syntax — 'head' and 'tail' don't exist. Use 'Select-Object -First N' or 'Get-Content | Select -First N' instead. Use 'type' instead of 'cat'. Paths use backslash or forward slash (both work). The shell is cmd.exe (not bash). "
      + "SERVER COMMANDS ARE BLOCKED. Do NOT use run_command for: python app.py, python manage.py runserver, python server.py, python run.py, python main.py, flask run, uvicorn, gunicorn, npm start, npm run dev, node server.js, go run, cargo run, next dev, vite. These will be rejected — use run_in_terminal instead. "
      + "Use for ONLY: tests, lint, git, pip install, npm install, building, compiling, type-checking, reading files.",
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
      + "User must Allow each command. After Allow, the command runs and you will receive the full terminal output as the result — you will always see runtime errors (Traceback, EADDRINUSE, etc.) before your next turn. "
      + "The terminal output is your tool result. "
      + "Use for: starting servers (python app.py, npm start, flask run), watching builds, interactive shells. "
      + "For short commands (tests, git, install, lint) use run_command instead. "
      + "CRITICAL — after receiving the terminal output, follow these steps IN ORDER: "
      + "1) CHECK THE OUTPUT for errors. Look for these patterns: "
      + "   - \`Traceback (most recent call last)\` → Python runtime error, read the stack trace "
      + "   - \`ModuleNotFoundError: No module named 'X'\` → missing Python package, run \`pip install X\` "
      + "   - \`ImportError\` / \`cannot import name\` → broken import, circular import, or missing __init__.py "
      + "   - \`Error: Cannot find module 'X'\` → missing npm package, run \`npm install\` "
      + "   - \`Address already in use\` / \`EADDRINUSE\` → port conflict, kill existing process or use different port "
      + "   - \`Error: listen EACCES\` → permission denied on port, use port > 1024 "
      + "   - \`npm ERR!\` → npm error, read the error message "
      + "   - \`fatal error\` / \`panic\` / \`segmentation fault\` → Go/Rust/C/C++ crash "
      + "   - \`SyntaxError\` → code syntax issue, fix and restart "
      + "   If you see ANY of these, fix the error FIRST. Do NOT proceed to browser navigation. "
      + "2) If NO runtime errors in terminal output: call \`browser_info\` to check if a tab opened. If not, call \`browser_navigate\` to the likely URL (e.g. http://localhost:5000), then \`browser_screenshot\` or \`browser_get_dom\` to verify the page loads. "
      + "3) If the page returns a 500 error or doesn't load — check \`browser_console\` and \`browser_request_errors\` for the cause. "
      + "Do NOT continue with the task until you've confirmed the server is running and the page loads successfully.",
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
  {
    name: "read_command_output",
    description:
      "Re-read output from a previous run_command call. Use this when the output was truncated "
      + "(showing only the last 4000 chars) and you need to see earlier lines, the top of the output, "
      + "or filter for specific lines. The command ID is shown as `[cmd #N]` in the original result. "
      + "Use offset and limit for pagination (e.g. offset=0 limit=100 reads the first 100 lines). "
      + "Use priority=top to read from the beginning, priority=bottom (default) for the end. "
      + "Use a regex filter to extract only matching lines (e.g. filter='error|ERR|FAIL').",
    parameters: {
      type: "object",
      properties: {
        cmd_id: { type: "integer", description: "The command sequence number (e.g. 1, 2) from [cmd #N] in the result." },
        offset: { type: "integer", description: "Line offset (0-based, default: 0)." },
        limit: { type: "integer", description: "Max lines to return (default: 200)." },
        priority: { type: "string", enum: ["top", "bottom"], description: "Read from top or bottom of output (default: bottom)." },
        filter: { type: "string", description: "Regex filter — only return lines matching this pattern (case-insensitive)." },
      },
      required: ["cmd_id"],
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
    const MAX_CACHE = 50000; // full output cache limit
    const HARD_TIMEOUT_MS = 45000;
    const IDLE_TIMEOUT_MS = 2000; // resolve early if output stops for this long
    let buf = "";
    let fullBuf = "";  // untruncated — saved to commandOutputStore
    let totalChars = 0;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Command sanitization ──

    // Block cd/pushd — the working directory is already the project root.
    const stripped = command.trimStart();
    if (/^(?:cd|pushd|chdir)\b/i.test(stripped)) {
      resolve(`Blocked: do NOT use cd/pushd. The working directory is already the project root (${cwd}). Just run the command directly.`);
      return;
    }

    // Block common long-running servers — redirect to run_in_terminal.
    // Exempt compiler/linter/package-manager invocations that happen to match.
    const COMPILER_PATTERNS = [
      /\bpython\b.*-m\s+(py_compile|compileall|pytest|pip)\b/i,
      /\bpython\b.*-c\s/i,  // python -c "..." is inline code, not a server
      /\bpython\b.*-\w*c\b/i,  // -c flag variants
      /\bpip\b/i, /\bpytest\b/i, /\bpylint\b/i, /\bflake8\b/i, /\bblack\b/i,
    ];
    const isCompiler = COMPILER_PATTERNS.some((pat) => pat.test(stripped));

    if (!isCompiler) {
      const SERVER_PATTERNS = [
        // Python servers — match ANY `python somefile.py` that isn't a known compiler/linter
        /\bpython(?:\.exe)?\s+.*\.py\b/i,
        /\bpython(?:\.exe)?\s+.*-m\s+(?:flask|uvicorn|gunicorn|django|fastapi)\b/i,
        /\b(?:flask|uvicorn|gunicorn)\s+/i,
        /\bmanage\.py\b/i,
        // Node.js servers
        /\bnpm\s+(?:start|run\s+dev|run\s+serve|run\s+start)\b/i,
        /\bnpx\s+.*\b(?:serve|dev|start)\b/i,
        /\bnode\s+.*\b(index|server|app)\.(?:js|mjs|cjs|ts)\b/i,
        // Go / Rust
        /\bgo\s+run\b/i, /\bcargo\s+run\b/i,
        // Other frameworks
        /\bnext\s+(?:dev|start)\b/i,
        /\b(?:vite|webpack-dev-server)\b/i,
      ];
      for (const pat of SERVER_PATTERNS) {
        if (pat.test(stripped)) {
          // Replace run_command with run_in_terminal in the message so the LLM has the exact fix
          const fixed = stripped.replace(/^\s*/, "");
          resolve(`BLOCKED: this is a server start command. DO NOT retry with a different path or syntax — use run_in_terminal instead.\n`
            + `Original command: "${fixed}"\n`
            + `Correct approach: call run_in_terminal with command="${fixed}"\n`
            + `The user will Allow it, then you will receive the terminal output.`);
          return;
        }
      }
    }

    // Auto-convert Linux head/tail to PowerShell on Windows
    if (process.platform === "win32") {
      // Replace "| head -N" with PowerShell Select-Object equivalent
      // Since the shell is cmd.exe, we need to pipe to powershell -Command
      const headMatch = stripped.match(/^(.*)\|\s*head\s+-(\d+)\s*$/i);
      if (headMatch && !stripped.includes("powershell")) {
        const actualCmd = headMatch[1].trim();
        const n = headMatch[2];
        command = `${actualCmd} | powershell -Command "$input | Select-Object -First ${n}"`;
      }
      const tailMatch = stripped.match(/^(.*)\|\s*tail\s+-(\d+)\s*$/i);
      if (tailMatch && !stripped.includes("powershell")) {
        const actualCmd = tailMatch[1].trim();
        const n = tailMatch[2];
        command = `${actualCmd} | powershell -Command "$input | Select-Object -Last ${n}"`;
      }
    }

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
      // Save full output to cache for later re-reading
      const seq = ++cmdSeq;
      commandOutputStore.set(seq, {
        command,
        output: fullBuf.trimEnd(),
        totalChars,
        exitCode: code,
        timedOut,
      });
      // Keep only the last 50 commands in cache
      if (commandOutputStore.size > 50) {
        const oldest = Math.min(...commandOutputStore.keys());
        commandOutputStore.delete(oldest);
      }
      const header = `[cmd #${seq}] `;
      const result = header + prefix + (out || "(command completed with no output)");
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
      fullBuf = (fullBuf + text).slice(-MAX_CACHE); // untruncated cache
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

function readCommandOutput(params: Record<string, unknown>): string {
  const seq = Number(params.cmd_id);
  if (!seq || isNaN(seq)) return "Error: cmd_id is required (e.g. 1, 2 from [cmd #N] in result).";

  const entry = commandOutputStore.get(seq);
  if (!entry) return `Command #${seq} not found. It may have been evicted from the cache (max 50 commands) or never existed.`;

  const lines = entry.output.split("\n");
  const totalLines = lines.length;
  const offset = Number(params.offset) || 0;
  const limit = Number(params.limit) || 200;
  const priority = String(params.priority || "bottom");
  const filterStr = String(params.filter || "");

  let selected = lines;

  // Apply regex filter
  if (filterStr) {
    try {
      const re = new RegExp(filterStr, "i");
      selected = lines.filter((l) => re.test(l));
    } catch {
      return `Invalid regex filter: ${filterStr}`;
    }
  }

  // Apply priority-based slicing
  let slice: string[];
  if (priority === "top") {
    slice = selected.slice(offset, offset + limit);
  } else {
    // bottom: offset counts from the end
    const start = Math.max(0, selected.length - limit - offset);
    slice = selected.slice(start, start + limit);
  }

  const header = [
    `Command #${seq}: ${entry.command}`,
    `Total: ${totalLines} lines, ${entry.totalChars} chars${filterStr ? ` (filter: /${filterStr}/i matched ${selected.length} lines)` : ""}`,
    `Exit code: ${entry.exitCode ?? "N/A"}${entry.timedOut ? ", timed out" : ""}`,
    priority === "top"
      ? `Showing lines ${offset + 1}-${Math.min(offset + limit, selected.length)} (from top)`
      : `Showing ${Math.min(offset + limit, selected.length)} lines from bottom (offset ${offset})`,
    ``,
  ].join("\n");

  return header + slice.join("\n");
}

// Auto-detect the best compile/check command for the current project.
// Returns a command string ready to pass to run_command.
function detectProjectBuild(root: string): string | null {
  const hasExt = (ext: string) => {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      return entries.some((e) => e.isFile() && e.name.endsWith(ext));
    } catch { return false; }
  };
  const hasFile = (name: string) => {
    try { return fs.existsSync(path.join(root, name)); } catch { return false; }
  };
  // Order matters — check build-system configs before file extensions.
  if (hasFile("Cargo.toml")) return "cargo check 2>&1";
  if (hasFile("go.mod")) return "go vet ./... 2>&1";
  if (hasFile("pom.xml")) return "mvn compile 2>&1";
  if (hasFile("build.gradle") || hasFile("build.gradle.kts")) return "gradle compileJava 2>&1";
  if (hasFile("package.json")) {
    // Prefer tsc --noEmit if tsconfig exists; otherwise fall back to build script.
    if (hasFile("tsconfig.json")) return "npx tsc --noEmit 2>&1";
    const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")); } catch { return null; } })();
    if (pkg?.scripts?.build) return "npm run build 2>&1";
    return "npx tsc --noEmit 2>&1"; // best guess
  }
  if (hasFile("requirements.txt") || hasFile("pyproject.toml") || hasFile("setup.py") || hasExt(".py"))
    return "python -m compileall . 2>&1";
  if (hasFile("Gemfile")) return "ruby -c *.rb 2>&1";
  if (hasFile("composer.json")) return "php -l *.php 2>&1";
  if (hasFile("Makefile")) return "make 2>&1";
  if (hasFile("CMakeLists.txt")) return "cmake --build build 2>&1";
  return null;
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
  if (name === "read_command_output") {
    return readCommandOutput(params);
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
const HISTORY_COMPACTION_TRIGGER_MESSAGES = 24;
const HISTORY_COMPACTION_TRIGGER_TOKENS = 10_000;
const HISTORY_PLAIN_MESSAGES_TO_KEEP = 6;
const HISTORY_SUMMARY_LINE_LIMIT = 12;
const HISTORY_SUMMARY_CHAR_BUDGET = 2_400;
const TOOL_RESULT_SUMMARY_LINE_LIMIT = 8;
const TOOL_RESULT_SUMMARY_CHAR_BUDGET = 1_200;
const IMPORTANT_OUTPUT_RE = /(error|warning|failed|failure|exception|traceback|cannot|not found|undefined|invalid|timeout|timed out|listening on|running on|localhost:|127\.0\.0\.1|compiled successfully|build succeeded|tests? passed|tests? failed)/i;

type ModelMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: any[];
  reasoning_content?: string;
};

function clipText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "...";
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function estimateStateTokens(state: Pick<AgentState, "messages" | "historySummary">): number {
  const totalChars = state.messages.reduce((sum, m) =>
    sum + (m.content?.length || 0) + (m.tool_call_id?.length || 0) + (m.name?.length || 0) + (m.reasoning_content?.length || 0), 0)
    + (state.historySummary?.length || 0);
  return Math.round(totalChars / 4);
}

function isPlainConversationMessage(message: AgentMessage): boolean {
  return message.role === "user" || (message.role === "assistant" && !message.name);
}

function mergeHistorySummary(existingSummary: string | undefined, compactedMessages: AgentMessage[]): string {
  const lines: string[] = [];
  if (existingSummary) {
    const previous = clipText(existingSummary.replace(/\n+/g, " "), 320);
    if (previous) lines.push(`Earlier summary: ${previous}`);
  }
  for (const message of compactedMessages) {
    const content = clipText(message.content || "", 220);
    if (!content) continue;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${content}`);
  }
  const deduped = dedupeStrings(lines).slice(-HISTORY_SUMMARY_LINE_LIMIT);
  const summaryLines: string[] = [];
  let totalChars = 0;
  for (let i = deduped.length - 1; i >= 0; i--) {
    const candidate = `- ${deduped[i]}`;
    const nextChars = totalChars + candidate.length + (summaryLines.length ? 1 : 0);
    if (nextChars > HISTORY_SUMMARY_CHAR_BUDGET && summaryLines.length > 0) break;
    summaryLines.unshift(candidate);
    totalChars = nextChars;
  }
  return summaryLines.join("\n");
}

function compactAgentHistory(state: AgentState): void {
  const plainIndexes = state.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isPlainConversationMessage(message))
    .map(({ index }) => index);
  if (plainIndexes.length <= HISTORY_PLAIN_MESSAGES_TO_KEEP) return;

  const overMessageLimit = state.messages.length >= HISTORY_COMPACTION_TRIGGER_MESSAGES;
  const overTokenLimit = estimateStateTokens(state) >= HISTORY_COMPACTION_TRIGGER_TOKENS;
  if (!overMessageLimit && !overTokenLimit) return;

  const indexesToCompact = new Set(plainIndexes.slice(0, -HISTORY_PLAIN_MESSAGES_TO_KEEP));
  if (indexesToCompact.size === 0) return;

  const compactedMessages = state.messages.filter((_, index) => indexesToCompact.has(index));
  if (compactedMessages.length === 0) return;

  state.historySummary = mergeHistorySummary(state.historySummary, compactedMessages);
  state.messages = state.messages.filter((_, index) => !indexesToCompact.has(index));
}

function extractCommandId(text: string): number | null {
  const match = text.match(/\[cmd #(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function summarizeCommandResult(raw: string, label: string): string {
  const commandId = extractCommandId(raw);
  const exitMatch = raw.match(/^Exit code (\d+):/);
  const timedOut = /\[Command timed out after \d+s\]/.test(raw);
  const normalized = raw.replace(/^Exit code \d+:\s*/, "");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[cmd #\d+\]\s*/, "").trim())
    .filter(Boolean);

  const prioritized = dedupeStrings(lines.filter((line) => IMPORTANT_OUTPUT_RE.test(line)));
  const fallback = dedupeStrings(lines);
  const chosen = (prioritized.length > 0 ? prioritized : fallback)
    .slice(0, TOOL_RESULT_SUMMARY_LINE_LIMIT)
    .map((line) => `- ${clipText(line, 220)}`);

  const headerParts = [label];
  if (exitMatch) headerParts.push(`Exit code ${exitMatch[1]}.`);
  if (timedOut) headerParts.push("Timed out.");
  if (commandId != null) headerParts.push(`Full output is cached as cmd #${commandId}; call read_command_output for more.`);

  let summary = headerParts.join(" ");
  if (chosen.length > 0) {
    summary += `\nKey lines:\n${chosen.join("\n")}`;
  } else {
    summary += "\nKey lines:\n- (command completed with no output)";
  }
  if (summary.length > TOOL_RESULT_SUMMARY_CHAR_BUDGET) {
    summary = clipText(summary, TOOL_RESULT_SUMMARY_CHAR_BUDGET);
  }
  return summary;
}

async function runReadProblems(root: string): Promise<{ raw: string; summary: string }> {
  const cmd = detectProjectBuild(root);
  if (!cmd) {
    const summary = "No build system detected. Try a specific command with run_command (e.g. npx tsc --noEmit, python -m compileall ., go vet ./...).";
    return { raw: summary, summary };
  }
  const raw = await runCommand(cmd, root);
  return {
    raw,
    summary: summarizeCommandResult(raw, `Build check (${cmd})`),
  };
}

function getStoredToolResult(name: string, rawResult: string): string {
  if (name === "run_command") return summarizeCommandResult(rawResult, "Command finished.");
  return rawResult;
}

function buildOpenAiMessages(state: AgentState, context: string): ModelMessage[] {
  compactAgentHistory(state);
  const promptMessages = state.historySummary
    ? [{ role: "assistant", content: state.historySummary } as AgentMessage, ...state.messages]
    : state.messages;
  const systemMsg = buildSystemPrompt(promptMessages, context)
    + (state.historySummary ? `\n\n### Earlier conversation summary\n${state.historySummary}` : "");

  const msgs: ModelMessage[] = [{ role: "system", content: systemMsg }];
  const pendingIds = new Set<string>();

  for (const message of state.messages) {
    if (message.role === "tool") {
      const toolId = message.tool_call_id;
      if (toolId && pendingIds.has(toolId)) {
        pendingIds.delete(toolId);
        msgs.push({ role: "tool", content: message.content, tool_call_id: toolId });
      }
      continue;
    }

    if (message.role === "assistant" && message.name) {
      for (const id of pendingIds) {
        msgs.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result.", tool_call_id: id });
      }
      pendingIds.clear();

      try {
        const calls: Array<{ id?: string }> = JSON.parse(message.content);
        const ids = calls.map((call) => call.id).filter(Boolean) as string[];
        for (const id of ids) pendingIds.add(id);
        msgs.push({
          role: "assistant",
          content: null,
          tool_calls: calls,
          ...(message.reasoning_content || state.isReasoningModel ? { reasoning_content: message.reasoning_content || "" } : {}),
        });
      } catch {
        msgs.push({
          role: "assistant",
          content: message.content,
          ...(message.reasoning_content || state.isReasoningModel ? { reasoning_content: message.reasoning_content || "" } : {}),
        });
      }
      continue;
    }

    msgs.push(message);
  }

  for (const id of pendingIds) {
    msgs.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result.", tool_call_id: id });
  }

  return msgs;
}

// ── Dynamic Instruction Retrieval (ITR) ──
// The system prompt is broken into themed chunks. At each agent turn,
// buildSystemPrompt() selects only the chunks relevant to the current
// conversation context, reducing token usage by up to ~95% compared
// to sending the full prompt every turn.

interface PromptChunk {
  id: string;
  content: string;
  /** Keywords/patterns that trigger this chunk. */
  triggers: string[];
  /** If true, this chunk is always included. */
  always?: boolean;
}

const CORE_RULES = `You are an expert software developer agent running inside a web IDE called Harness.
You have access to tools that let you read/write files, run commands, interact with a browser preview, and inspect the current page.

### Rules
1. Break the user's request into steps. Use \`write_todos\` to plan and track progress.
2. Use tools one at a time. After each tool call, read the result before deciding the next step.
3. When you are done, call \`task_complete\` with a summary.
4. If you encounter an error, explain what happened and suggest how to fix it.
5. Keep responses concise — one sentence of reasoning, one tool call.
6. Do NOT guess browser DOM indices — call \`browser_get_dom\` first.
7. **Before interacting with a web app in the browser, you MUST start the server first.** Use \`run_in_terminal\` to start the server, wait for the user to Allow the command. Then CHECK THE TERMINAL OUTPUT for runtime errors BEFORE navigating to the browser. Only call \`browser_info\` after confirming the terminal output shows no errors.
8. After starting a server, do NOT guess the URL or port. Call \`browser_info\` to check if a tab opened. If none, ask the user for the URL.
9. Only use tools from the registry. NEVER invent tools — use \`read_file\` (not cat/head/tail), \`list_files\` (not ls/dir), \`search_files\` (not find/locate), \`grep\` (the tool, not the shell command), \`edit_file\` (not sed/awk), \`write_file\` (not echo>/cp), \`run_command\` for short commands, \`run_in_terminal\` for servers.

### File conventions
- All file paths are relative to the project root.
- Use \`read_file\` to see existing code before editing it.
- PREFER \`edit_file\` for any change to an existing file — only send the exact lines that change. old_string must match exactly including whitespace/indentation. If it matches multiple locations, set replace_all to true or make it more specific. This is much cheaper (fewer tokens) and preserves the file's history.
- Use \`write_file\` ONLY for creating a brand-new file, or when the entire file needs to be rewritten from scratch.
- Use \`list_files\` to browse a specific directory.
- Use \`search_files\` to find any file or folder anywhere in the project (by name pattern).
- Use \`grep\` to search file contents for a string or regex — find definitions, usages, references.

Current time: ${new Date().toISOString()}`;

const BROWSER_USAGE = `### Browser usage
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

**If submits, navigations, or dialog triggers don't work** — use \`browser_eval\` to inspect the page state or trigger the action programmatically.`;

const BUILD_FIX_LOOP = `### Build & fix loop
CRITICAL: After making ANY code changes, follow this flow to catch and fix errors:
1. Determine the project language and use the correct validation command (see language guides).
2. Read the output carefully. The sandbox returns stdout + stderr — compile errors, lint warnings, and test failures are all there.
3. If the build FAILS: identify the file, line, and error message from the output. Fix it with \`edit_file\`. Then build again.
4. Repeat step 3 until the build passes with zero errors.
5. Build passes? Proceed to the next task step.`;

const LANG_JS = `### JavaScript / TypeScript troubleshooting
Build commands:
  - \`npx tsc --noEmit\` — type-check without emitting (preferred, catches all type errors)
  - \`npm run build\` — full build (check package.json scripts first)
  - \`npx eslint .\` — lint only (if ESLint is configured)
Error patterns:
  - \`error TS2345: Argument of type 'X' is not assignable\` → type mismatch
  - \`Cannot find module 'X'\` → missing import or missing npm package (run \`npm install\`)
  - \`Property 'X' does not exist on type 'Y'\` → add the property to the type/interface, or fix the access
  - \`'X' is declared but its value is never read\` → unused variable, remove it or use it
Runtime debugging:
  - After starting a dev server, use \`browser_console\` to check for JS errors in the browser
  - Use \`browser_request_errors\` to check for failed API calls (404, 500, CORS)
  - Common runtime issues: undefined variables, null property access, unhandled promise rejections`;

const LANG_PYTHON = `### Python troubleshooting
Build commands:
  - \`python -m py_compile file.py\` — check single file syntax
  - \`python -m compileall .\` — compile all .py files, catches syntax errors
  - \`python -m pytest\` — run tests (if pytest is configured)
  - \`pip install -r requirements.txt\` — install dependencies before running
Error patterns — Python tracebacks are read BOTTOM-UP (last line is the actual error):
  - \`Traceback (most recent call last)\` → always read from the bottom; the LAST line is the actual error type and message
  - \`ModuleNotFoundError: No module named 'X'\` → missing import or package not installed. Run \`pip install X\` or fix the import path.
  - \`ImportError: cannot import name 'X'\` → circular import, broken import chain, or missing \`__init__.py\`
  - \`NameError: name 'X' is not defined\` → variable used before assignment, typo, or missing import
  - \`AttributeError: 'X' object has no attribute 'Y'\` → wrong attribute name, wrong object type, or None where object expected
  - \`TypeError: X() missing N required positional argument\` → wrong number or type of function arguments
  - \`ValueError\` → bad value passed (e.g. int('abc'), list.index() of missing item, wrong config format)
  - \`KeyError: 'X'\` → missing dictionary key; check the data structure or use .get()
  - \`IndexError: list index out of range\` → accessing list position that doesn't exist
  - \`FileNotFoundError: [Errno 2] No such file or directory\` → wrong file path, missing config file, or directory doesn't exist
  - \`PermissionError: [Errno 13] Permission denied\` → can't read/write file, or port < 1024 on Linux
  - \`IndentationError\` / \`TabError\` → mixed tabs/spaces or wrong indentation level
  - \`SyntaxError\` → usually shows exact line with a caret (^) pointing to the problem
  - \`ZeroDivisionError: division by zero\` → math error, check denominator
Runtime debugging for web apps (Flask/Django/FastAPI):
  - After \`run_in_terminal\`, use \`browser_console\` and \`browser_request_errors\` to see HTTP errors
  - Flask debug mode shows full tracebacks in the browser on 500 errors — use \`browser_screenshot\` or \`browser_get_dom\` to read them
  - Common pitfalls: missing template files, undefined Jinja2 variables, database connection failures, port already in use`;

const LANG_GO = `### Go troubleshooting
Build commands:
  - \`go build ./...\` — compile all packages
  - \`go vet ./...\` — run static analysis (catches common mistakes)
  - \`go test ./...\` — run all tests
Error patterns:
  - \`undefined: X\` → missing import or undefined variable/function
  - \`cannot use X (type Y) as type Z\` → type mismatch
  - \`imported and not used: "X"\` → remove unused import (Go forbids unused imports)
  - \`X declared and not used\` → remove unused variable or use \`_\` to discard
  - Errors include exact file:line:column — use those coordinates directly`;

const LANG_RUST = `### Rust troubleshooting
Build commands:
  - \`cargo check\` — fast compile check without producing a binary (preferred for quick feedback)
  - \`cargo build\` — full compilation
  - \`cargo test\` — run tests
  - \`cargo clippy\` — lint with extra warnings (if installed)
Error patterns:
  - Rust error messages are detailed and include suggested fixes — READ THE SUGGESTION before editing
  - \`error[E0308]: mismatched types\` → type mismatch, the error shows expected vs found types
  - \`error[E0597]: X does not live long enough\` → lifetime issue, check borrow scope
  - \`error[E0382]: use of moved value\` → ownership issue, clone or borrow instead
  - \`error[E0277]: the trait bound X: Y is not satisfied\` → missing trait implementation
  - Errors show exact file:line:column — use these directly`;

const LANG_JAVA = `### Java troubleshooting
Build commands:
  - \`mvn compile\` (Maven) or \`gradle build\` (Gradle) — check build config files (\`pom.xml\`, \`build.gradle\`)
  - No build tool? Use \`javac File.java\` for single files
Error patterns:
  - \`cannot find symbol\` → missing import or undefined class/method
  - \`incompatible types\` → type mismatch
  - \`unreported exception X; must be caught or declared to be thrown\` → missing try/catch or throws clause
  - Errors show class name, line number, and column — use those to locate the issue`;

const LANG_C = `### C / C++ troubleshooting
Build commands:
  - \`gcc -Wall -Wextra file.c -o output\` (C) or \`g++ -Wall -Wextra file.cpp -o output\` (C++)
  - \`cmake --build build\` (CMake projects)
  - \`make\` (Makefile projects)
Error patterns:
  - \`undefined reference to 'X'\` → linker error, missing function definition or library
  - \`error: expected ';' before X\` → missing semicolon
  - \`warning: implicit declaration of function 'X'\` → missing header include
  - \`segmentation fault\` at runtime → null pointer, buffer overflow, or use-after-free — check pointer usage`;

const LANG_RUBY = `### Ruby troubleshooting
Build commands:
  - \`ruby -c file.rb\` — syntax check only (cheap, catches syntax errors)
  - \`bundle exec rake test\` or \`bundle exec rspec\` — run tests
  - \`bundle install\` — install gem dependencies before running
Error patterns:
  - \`NameError: undefined local variable or method 'X'\` → typo or missing definition
  - \`NoMethodError: undefined method 'X' for Y\` → wrong object type or missing method
  - \`LoadError: cannot load such file -- X\` → missing gem, run \`bundle install\` or \`gem install X\`
  - \`SyntaxError\` → shows exact line, usually missing \`end\` or wrong syntax`;

const LANG_PHP = `### PHP troubleshooting
Build commands:
  - \`php -l file.php\` — syntax check (lint) only
  - \`php -l *.php\` — lint all PHP files in directory
  - \`composer install\` — install dependencies
Error patterns:
  - \`Parse error: syntax error, unexpected X\` → missing semicolon, bracket, or wrong syntax
  - \`Fatal error: Class 'X' not found\` → missing require/include or autoload issue
  - \`Fatal error: Call to undefined function X()\` → missing extension or typo`;

const LANG_SHELL = `### Shell (Bash) troubleshooting
Build commands:
  - \`bash -n script.sh\` — syntax check without executing (safe, catches syntax errors)
  - \`shellcheck script.sh\` — static analysis (if installed, highly recommended)
Error patterns:
  - \`command not found\` → missing program or typo in command name
  - \`Permission denied\` → script not executable, or file permissions wrong
  - \`unexpected token\` → syntax error, usually missing quote or bracket`;

const LANG_GENERAL = `### General multi-language tips
- When you don't know the language: check the file extensions in the project. Look for config files (\`package.json\`, \`requirements.txt\`, \`go.mod\`, \`Cargo.toml\`, \`pom.xml\`, \`Gemfile\`, \`composer.json\`) to identify the stack.
- If a test fails: ALWAYS read the full failure output. It tells you exactly what went wrong — expected vs actual values, error messages, and stack traces.
- After fixing an error, ONLY re-run the build command — don't re-run tests or other commands until the build passes.
- For web projects: after starting the server, check the browser (with browser tools) for runtime errors even if the build passed. Build success does not guarantee runtime success.`;

const SERVER_STARTUP = `### Server startup troubleshooting
CRITICAL: After starting a server with \`run_in_terminal\`, READ THE TERMINAL OUTPUT before navigating to the browser. The terminal shows runtime errors that compile checks miss.

**Python servers** (Flask/Django/FastAPI):
- \`Traceback (most recent call last)\` → read the traceback from the BOTTOM up to find the actual error
- \`ModuleNotFoundError: No module named 'X'\` → run \`pip install X\`, then restart the server
- \`ImportError: cannot import name 'X'\` → check for circular imports or typos in import statements
- \`SyntaxError\` / \`IndentationError\` → shows exact line with caret (^); fix and restart
- \`Address already in use\` → the port is taken; kill the existing process or change the port
- No output at all → the server started but may be running on a different port; check for "Running on http://..."
- If the terminal output ends with \`(venv) PS D:\\...>\` or \`$\`, the command has exited — check output for errors above

**Node.js servers** (Express/Next.js/Vite):
- \`Error: Cannot find module 'X'\` → run \`npm install\` to install missing dependencies
- \`npm ERR!\` → read the error; usually a missing package, version conflict, or broken node_modules
- \`EADDRINUSE\` / \`Error: listen EADDRINUSE\` → port conflict, kill existing process or use different port
- \`Error: listen EACCES\` → permission denied (port < 1024 on Linux); use a higher port
- \`TypeError: X is not a function\` → code bug; read the stack trace and fix the source

**Go servers**: \`panic: runtime error\` → runtime crash; \`listen tcp :X: bind: address already in use\` → port conflict
**Rust servers**: \`thread 'main' panicked at\` → runtime panic; \`error: could not compile\` → compile error

**General pattern**:
1. Start server with \`run_in_terminal\` → user clicks Allow → you receive the terminal output
2. Errors are auto-detected — if the server crashes (Python traceback, npm ERR, port conflict, etc.), you will see this output immediately
3. CHECK THE TERMINAL OUTPUT for any of the error patterns above
4. If errors found: use \`read_file\` to open the failing file, \`edit_file\` to fix, then restart the server
5. If no errors AND the server shows "Running on http://..." or similar: call \`browser_info\`, then \`browser_navigate\` if needed
6. If no server output at all: the server may have hung; check the code for blocking operations or missing startup messages`;

const DIAGNOSTICS = `### Diagnostics
- Use \`read_problems\` to check for compile/lint errors — it auto-detects your project's build system and runs the right command (tsc --noEmit, python -m compileall, go vet, cargo check, etc.). This is the easiest way to check for errors after making changes.
- Use \`run_command\` for specific build/test/lint commands when you know the exact command you want.
- Use \`browser_console\` to inspect browser console output for runtime errors.
- Use \`browser_request_errors\` to check for failed network requests in the browser.
- **When \`run_command\` output is truncated**: every \`run_command\` result starts with \`[cmd #N]\`. If you see \`... (showing last 4000 of N chars)\`, use \`read_command_output cmd_id=N\` to re-read the output with pagination. Use \`priority=top\` to see the beginning, \`limit=N\` to control how many lines, \`offset=N\` to advance through pages, or \`filter="pattern"\` to extract only matching lines.

### Terminal
- Use \`run_command\` for sandboxed short commands: tests, lint, git, pip, npm, builds, etc. (no permission needed, fast inline output).
- Use \`run_in_terminal\` for long-running commands: starting servers, watch mode, interactive shells. User must Allow. You receive the full terminal output before your next turn.
- The working directory is already the project root — do NOT use cd/pushd.
- After starting a web server with \`run_in_terminal\`: CHECK THE TERMINAL OUTPUT for runtime errors FIRST. Then call \`browser_info\` to see if the terminal auto-opened a browser tab. If no tab is open, ask the user for the URL — do NOT guess the port.`;

// ── Chunk registry ──
const PROMPT_CHUNKS: PromptChunk[] = [
  {
    id: "browser",
    content: BROWSER_USAGE,
    triggers: [
      "browser_", "DOM", "navigate", "screenshot", "click", "type",
      "web", "UI", "frontend", "page", "HTML", "CSS", "form",
      "modal", "dialog", "dropdown", "autocomplete", "hover",
    ],
  },
  {
    id: "build_fix",
    content: BUILD_FIX_LOOP,
    triggers: [
      "build", "compile", "error", "fails", "lint", "test fail",
      "fix", "debug", "edit_file", "write_file", "read_problems",
      "run_command", "type-check", "syntax",
    ],
  },
  {
    id: "lang_js",
    content: LANG_JS,
    triggers: [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "package.json",
      "typescript", "javascript", "node", "npm", "npx", "tsc",
      "react", "vue", "angular", "next", "vite", "webpack", "eslint",
      "TS", "JSX", "esm", "cjs", "require(", "import ",
    ],
  },
  {
    id: "lang_python",
    content: LANG_PYTHON,
    triggers: [
      ".py", "python", "pip", "pytest", "flask", "django", "fastapi",
      "requirements.txt", "pyproject.toml", "setup.py", "conda",
      "traceback", "ModuleNotFoundError", "jinja", "uvicorn",
    ],
  },
  {
    id: "lang_go",
    content: LANG_GO,
    triggers: [
      ".go", "go.mod", "go.sum", "golang", "go build", "go vet",
      "go test", "go run",
    ],
  },
  {
    id: "lang_rust",
    content: LANG_RUST,
    triggers: [
      ".rs", "cargo", "Cargo.toml", "Cargo.lock", "rustc",
      "rust", "clippy", "crate",
    ],
  },
  {
    id: "lang_java",
    content: LANG_JAVA,
    triggers: [
      ".java", "pom.xml", "build.gradle", ".gradle", "maven", "mvn",
      "gradle", "javac", "spring", "classpath",
    ],
  },
  {
    id: "lang_c",
    content: LANG_C,
    triggers: [
      ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", "CMakeLists.txt",
      "gcc", "g++", "cmake", "makefile", "clang", "Makefile",
    ],
  },
  {
    id: "lang_ruby",
    content: LANG_RUBY,
    triggers: [
      ".rb", "Gemfile", "ruby", "rake", "rspec", "bundle", "gem",
      "rubocop", "rails",
    ],
  },
  {
    id: "lang_php",
    content: LANG_PHP,
    triggers: [
      ".php", "composer.json", "composer.lock", "php", "laravel",
      "symfony", "wordpress",
    ],
  },
  {
    id: "lang_shell",
    content: LANG_SHELL,
    triggers: [
      ".sh", ".bash", "shellcheck", "#!/bin/bash", "#!/bin/sh",
      "bash ", "shell script", "Makefile", ".mk",
    ],
  },
  {
    id: "lang_general",
    content: LANG_GENERAL,
    triggers: [],
    always: true,
  },
  {
    id: "server_startup",
    content: SERVER_STARTUP,
    triggers: [
      "run_in_terminal", "start server", "start the server", "dev server",
      "app.py", "npm start", "npm run dev", "flask run", "uvicorn",
      "manage.py runserver", "go run", "cargo run", "EADDRINUSE",
      "port", "listen", "Running on http",
    ],
  },
  {
    id: "diagnostics",
    content: DIAGNOSTICS,
    triggers: [
      "run_command", "read_problems", "read_command_output",
      "read_file", "terminal", "sandbox", "run_in_terminal",
      "build", "compile", "test", "lint", "error",
    ],
  },
];

// ── Dynamic system prompt builder ──
// Scans conversation messages, tool call names, and file paths to select
// only the relevant instruction chunks for the current turn.

/** Normalize text for keyword matching. */
function norm(text: string): string {
  return text.toLowerCase();
}

/** Count the number of trigger hits for a chunk in a body of text. */
function countTriggers(text: string, triggers: string[]): number {
  const t = norm(text);
  let count = 0;
  for (const trigger of triggers) {
    if (t.includes(norm(trigger))) count++;
  }
  return count;
}

/** Extract tool names from assistant messages that contain tool_calls JSON. */
function extractToolNames(
  messages: Array<{ role: string; content: string | null; name?: string }>,
): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.name) {
      names.push(m.name);
    } else if (m.role === "assistant" && m.content) {
      // Try parsing tool_calls JSON from content
      try {
        const calls = JSON.parse(m.content);
        if (Array.isArray(calls)) {
          for (const c of calls) {
            if (c.function?.name) names.push(c.function.name);
          }
        }
      } catch { /* not tool_calls JSON */ }
    }
  }
  return names;
}

function buildSystemPrompt(
  messages: Array<{ role: string; content: string | null; name?: string }>,
  context: string,
): string {
  // Always include core rules
  const parts: string[] = [CORE_RULES];

  // Build a combined text blob from all message content for keyword matching
  let combined = context || "";
  for (const m of messages) {
    if (m.content) combined += "\n" + m.content;
    if (m.role === "user") combined += "\n" + (m.content || "");
  }

  // Also scan tool names
  const toolNames = extractToolNames(messages);
  combined += "\n" + toolNames.join(" ");

  // Select optional chunks by trigger match score
  for (const chunk of PROMPT_CHUNKS) {
    if (chunk.always) {
      parts.push(chunk.content);
      continue;
    }
    const score = countTriggers(combined, chunk.triggers);
    // Browser chunk also activates when any browser_* tool has been called
    const browserBoost = (chunk.id === "browser" && toolNames.some((n) => n.startsWith("browser_"))) ? 5 : 0;
    if (score >= 2 || browserBoost > 0) {
      parts.push(chunk.content);
    }
  }

  // Append IDE context if provided
  if (context && context.trim()) {
    parts.push(`### Additional context from the IDE\n${context}`);
  }

  return parts.join("\n\n");
}

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

  // Dynamic instruction retrieval — only include relevant prompt chunks
  const openaiMessages = buildOpenAiMessages(state, context);

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

      // Capture original content before write_file / edit_file / delete_file for undo support
      let originalContent: string | null = null;
      if (fnName === "write_file" || fnName === "edit_file" || fnName === "delete_file") {
        const targetPath = path.resolve(projectRoot, String(params.path || ""));
        try { originalContent = fs.readFileSync(targetPath, "utf-8"); } catch { originalContent = null; }
      }

      // Check if this is a filesystem tool the server can execute directly.
      const fsResult = await runFsTool(fnName, params, projectRoot);
      if (fsResult !== null) {
        const storedResult = getStoredToolResult(fnName, fsResult);
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: storedResult, tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: storedResult.slice(0, 1000) });
        continue;
      }

      // read_problems: auto-detect project and run compile/lint.
      if (fnName === "read_problems") {
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        const diagResult = await runReadProblems(projectRoot);
        state.messages.push({ role: "tool", content: diagResult.summary, tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: diagResult.summary.slice(0, 1000) });
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
      // Push any remaining tool calls with "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result." responses so they aren't lost.
      // The actual result for the browser tool will be pushed by /continue.
      for (let i = browserBreakIdx + 1; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }]), name: tc.function.name, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result.", tool_call_id: tc.id });
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

  // Dynamic instruction retrieval — rebuilt each iteration as conversation evolves
  const buildMessages = () => {
    return buildOpenAiMessages(state, context);
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
    const estTokens = estimateStateTokens(state);
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
        const storedResult = getStoredToolResult(fnName, fsResult || "");
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: storedResult, tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: storedResult,
          toolSandbox: fsResult || "",
          executedTools: [{ name: fnName, result: storedResult.slice(0, 500) }],
        };
        executedTools.push({ name: fnName, result: storedResult.slice(0, 1000) });
        continue;
      }

      // run_in_terminal: requires user permission (opens real terminal tab)
      if (fnName === "run_in_terminal") {
        const cmd = String(params.command || "");
        // Push individual assistant+tool messages for each tool call.
        // run_in_terminal pauses for permission — push "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result." for all
        // other tools so they don't block. The actual run_in_terminal result
        // will be pushed by /stream/continue.
        for (let i = 0; i < finalToolCalls.length; i++) {
          const t = finalToolCalls[i];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          if (i > 0) {
            state.messages.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result.", tool_call_id: t.id });
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
        // browser_eval pauses for permission — push "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result." for all
        // other tools so they don't block. The actual eval result will be
        // pushed by /stream/continue.
        for (let i = 0; i < finalToolCalls.length; i++) {
          const t = finalToolCalls[i];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          if (i > 0) {
            state.messages.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result.", tool_call_id: t.id });
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

      // ── File tools: auto-execute, yield diff for Accept/Reject in UI ──
      const FILE_TOOLS = ["write_file", "edit_file", "delete_file", "rename_file"];
      if (FILE_TOOLS.includes(fnName)) {
        const fp = String(params.path || params.oldPath || "");
        // Push all tool calls as assistant messages; only this one gets executed
        for (let j = 0; j < finalToolCalls.length; j++) {
          const t = finalToolCalls[j];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          if (j !== i) {
            state.messages.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other tools. Do NOT interpret this as a real result. Call this tool BY ITSELF on your next turn to get the actual result.", tool_call_id: t.id });
          }
        }
        // Capture original content before executing
        let originalContent: string | null = null;
        const resolvedPath = path.resolve(projectRoot, fp);
        try { originalContent = fs.readFileSync(resolvedPath, "utf-8"); } catch { originalContent = null; }
        // Execute the file change immediately (no Allow/Deny — user reviews after)
        yield {
          type: "tool_start", toolName: fnName, toolParams: params,
          ...(originalContent !== null ? { originalContent } : {}),
        };
        const fsResult = await runFsTool(fnName, params, projectRoot);
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        // Defer the result — user must Accept/Reject before agent continues
        state.deferredTool = {
          toolCallId: tc.id,
          toolName: fnName,
          params: params as Record<string, unknown>,
          result: fsResult || "Done.",
          originalContent,
          filePath: fp,
        };
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: "Diff ready",
          toolParams: params,
          toolCallId: tc.id,
          originalContent,
          executedTools,
        };
        executedTools.push({ name: fnName, result: fsResult?.slice(0, 500) || "" });
        return;
      }

      // ── read_problems: auto-detect project and run compile/lint ──
      if (fnName === "read_problems") {
        yield { type: "tool_start", toolName: fnName, toolParams: params };
        const diagResult = await runReadProblems(projectRoot);
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: diagResult.summary, tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: diagResult.summary,
          toolSandbox: diagResult.raw,
          executedTools: [{ name: fnName, result: diagResult.summary.slice(0, 500) }],
        };
        executedTools.push({ name: fnName, result: diagResult.summary.slice(0, 1000) });
        continue;
      }

      // ── Read-only filesystem tools: auto-execute ──
      // write_file, edit_file, delete_file, and rename_file are handled above with deferred Accept/Reject.
      const isFsTool = [
        "read_file", "list_files", "search_files", "grep", "create_directory", "write_todos", "read_command_output",
      ].includes(fnName);

      if (isFsTool) {
        // For create_directory, capture the parent path (originalContent = parent dir contents)
        let originalContent: string | null = null;
        if (fnName === "read_file") {
          // read_file needs originalContent for no reason; skip
        }
        yield {
          type: "tool_start", toolName: fnName, toolParams: params,
          ...(originalContent !== null ? { originalContent } : {}),
        };
        const fsResult = await runFsTool(fnName, params, projectRoot);
        if (fsResult !== null) {
          const storedResult = getStoredToolResult(fnName, fsResult);
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          state.messages.push({ role: "tool", content: storedResult, tool_call_id: tc.id });
          yield {
            type: "tool_end",
            toolName: fnName,
            toolResult: storedResult.slice(0, 2000),
            executedTools: [{ name: fnName, result: storedResult.slice(0, 500) }],
          };
          executedTools.push({ name: fnName, result: storedResult.slice(0, 1000) });
        }
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
      // Push any remaining tool calls with "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result." responses so they aren't lost.
      // The actual result for the browser tool will be pushed by /stream/continue.
      for (let i = browserBreakIdx + 1; i < finalToolCalls.length; i++) {
        const tc = finalToolCalls[i];
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }]), name: tc.function.name, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result.", tool_call_id: tc.id });
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

// ── Command output cache ──
// Stores full raw output from run_command so the agent can re-read with pagination/filter.
// Keyed by incrementing sequence number returned in the tool result.
let cmdSeq = 0;
const commandOutputStore = new Map<number, { command: string; output: string; totalChars: number; exitCode: number | null; timedOut: boolean }>();

export function getCommandOutput(seq: number) {
  return commandOutputStore.get(seq);
}

export function clearCommandOutputs() {
  cmdSeq = 0;
  commandOutputStore.clear();
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
