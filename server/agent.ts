// ── Harness Agent: tool-calling loop for DeepSeek ──
// Supports browser tools (screenshot, DOM, click, type, eval, navigate),
// filesystem tools (read_file, write_file), and terminal (run_command).
//
// Two loops:
//   agentLoop()        — blocking, returns final result (used by /api/chat/agent)
//   agentLoopStream()  — async generator, yields SSE events (used by /api/chat/agent/stream)
//
// Conversation state is held in memory keyed by session id.

import { chatDeepSeekTool, chatDeepSeekToolStream, generateEmbedding, type DeepSeekApiUsage } from "./deepseek";
import { getMemoryStore } from "./memory";
import { killSession, getLastCreatedSessionId } from "./terminalManager";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
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
  /** Shared message prefix per sub-agent type — improves cache hit rates across
   *  repeated delegations of the same type within one agent session.
   *  Only stores tasks and summaries, not tool results (which could be stale). */
  subAgentPrefix?: Record<string, AgentMessage[]>;
  pendingPermission?: { toolCallId: string; command: string; background?: boolean; toolName?: string; params?: Record<string, unknown> };
  /** Deferred destructive file tool — executed on Allow, result held until Accept/Reject in UI. */
  deferredTool?: { toolCallId: string; toolName: string; params: Record<string, unknown>; result: string; originalContent: string | null; filePath: string };
  /** Paused sub-agent waiting for a browser tool result. Resumed in /continue. */
  pendingSubAgent?: {
    subState: AgentState;
    config: SubAgentConfig;
    task: string;
    agentType: string;
    /** The parent's delegate_task tool call ID — pushed to state only when sub-agent is done. */
    parentToolCallId: string;
    parentToolArgs: string;
    parentReasoning?: string;
  };
  /** Step-by-step mode: locked todo list populated during planning phase. */
  lockedTodos?: LockedTodo[];
  /** Current step index in step-by-step execution mode. */
  currentStepIndex?: number;
  /** Terminal sessions spawned by this agent via run_in_terminal. */
  agentTerminalSessions?: { sessionId: string; groupKey: string; command: string }[];
  /** Latest todo list from write_todos — used to detect incomplete tasks at task_complete. */
  latestTodos?: { id: string; text: string; status: string }[];
  /** Latest validated summary submitted via write_summary. Required before task_complete. */
  latestSummary?: string;
  /** Cumulative DeepSeek API usage across the current run. */
  apiUsageTotals?: DeepSeekApiUsage & { requestCount: number };
}

// ── Step-by-Step Types ──

export interface LockedTodo {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
  /** Which sub-agent profile was used for this step (default: "code-writer"). */
  agentType?: string;
}

// ── Sub-Agent Types ──

export interface SubAgentConfig {
  name: string;
  systemPrompt?: string;
  tools?: string[];
  maxIterations?: number;
  headless?: boolean;
}

export const SUB_AGENT_PROFILES: Record<string, SubAgentConfig> = {
  "browser": {
    name: "Browser Agent",
    tools: [
      "browser_navigate", "browser_info", "browser_screenshot", "browser_get_dom",
      "browser_click", "browser_type", "browser_clear", "browser_select",
      "browser_console", "browser_request_errors", "browser_scroll", "browser_wait",
      "browser_press_key",
    ],
    headless: false,
    maxIterations: 100,
    systemPrompt: `You are a browser automation specialist running as a sub-agent. Your job is to interact with a web page and report your findings to the parent agent.
- Use browser_navigate to go to a URL.
- Use browser_info to check the current URL and page title.
- Use browser_screenshot to get a text snapshot of visible content.
- Use browser_get_dom to get indexed interactive elements (buttons, inputs, links, forms).
- Use browser_click to click buttons, links, or activate inputs (by DOM index or x,y).
- Use browser_type to enter text into input fields (click the field first to activate it).
- Use browser_clear to clear input fields before typing.
- Use browser_select to pick an option from dropdown menus.
- Use browser_press_key to press keys (Enter, Escape, Tab, arrows).
- Use browser_scroll to reveal content below the fold.
- Use browser_wait to wait for specific elements to appear on dynamic pages.
- Use browser_console / browser_request_errors to check for errors.
- After analyzing, return a structured report in plain text: URL, title, key content, what you clicked/typed, results observed, any errors. Do NOT call task_complete or write_summary.`,
  },
  "code-search": {
    name: "Code Search Agent",
    tools: ["read_file", "list_files", "search_files", "grep", "read_graph"],
    headless: true,
    maxIterations: 20,
    systemPrompt: `You are a code-search specialist running as a sub-agent. Your ONLY job is to find and read relevant code in the project.
- Never create, edit, or delete files.
- Use read_file to inspect files, list_files to browse directories, search_files to find files by name, and grep to search file contents.
- Return a concise report of what you found with exact file paths and line numbers.
- Finish by returning your findings in plain text. Do NOT call task_complete or write_summary.`,
  },
  "code-writer": {
    name: "Code Writer Agent",
    tools: ["read_file", "write_file", "edit_file", "list_files", "search_files", "grep",
            "run_command", "read_problems", "read_command_output", "read_graph", "create_directory", "delete_file", "rename_file"],
    headless: true,
    maxIterations: 50,
    systemPrompt: `You are a code-writing specialist running as a sub-agent. Your job is to implement a specific feature or fix a specific bug.
- Read relevant files first to understand the existing code before making changes.
- Prefer edit_file for targeted changes; use write_file only for new files.
- After making changes, run the build/tests with run_command to verify.
- Fix any errors before completing.
- When done, return a structured summary in plain text using this exact template:
### Changes Made
- [file path]: [what was changed]
### Verification
- [build/test/check result]
### Outcome
- [concise description of what was accomplished]
Do NOT call task_complete or write_summary.`,
  },
  "researcher": {
    name: "Research Agent",
    tools: ["read_file", "list_files", "search_files", "grep", "run_command", "read_graph"],
    headless: true,
    maxIterations: 25,
    systemPrompt: `You are a codebase researcher running as a sub-agent. Explore the project to answer the user's question.
- Use list_files and search_files to understand the project structure.
- Use read_file to read relevant source files.
- Use grep to find where functions, classes, or patterns are used.
- Use run_command for short queries (git log, npm list, etc.) — but NEVER start servers.
- Report findings with exact file paths, line numbers, and relevant code snippets.
- Finish by returning your research findings in plain text. Do NOT call task_complete or write_summary.`,
  },
};

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
  type: "thinking" | "text" | "tool_start" | "tool_end" | "browser_tool" | "permission_required" | "done" | "error" | "warning" | "step_plan" | "step_begin" | "step_end";
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
  usage?: {
    estimatedTokens: number;
    contextLimit: number;
    turns: number;
    requestCount?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
  };
  /** The shell command that needs permission (on permission_required). */
  permissionCommand?: string;
  /** Whether background=true was set (on permission_required, for /continue). */
  backgroundPerm?: boolean;
  /** Sub-agent message trace (on tool_end for delegate_task). */
  subAgentMessages?: { role: string; content: string; name?: string; reasoning_content?: string }[];
  /** Sub-agent display name (on tool_end for delegate_task). */
  subAgentName?: string;
  /** When a browser_tool is yielded from within a sub-agent, this is the delegate_task's tool_call_id. */
  subAgentParentToolCallId?: string;
  /** Locked todo list (on step_plan). */
  lockedTodos?: LockedTodo[];
  /** Current step todo item (on step_begin / step_end). */
  stepTodo?: LockedTodo;
  /** All step results summary (on done for step-by-step mode). */
  allStepResults?: { text: string; status: string; result: string }[];
  /** True when this tool_start/tool_end came from a step sub-agent (for frontend color coding). */
  isSubAgent?: boolean;
  /** Agent marker for color coding: "main", "browser", "code-search", "code-writer", "researcher". */
  agentMarker?: string;
}

function addApiUsage(state: AgentState, usage: DeepSeekApiUsage | undefined) {
  if (!usage) return;
  const prev = state.apiUsageTotals || {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  };
  state.apiUsageTotals = {
    requestCount: prev.requestCount + 1,
    promptTokens: prev.promptTokens + usage.promptTokens,
    completionTokens: prev.completionTokens + usage.completionTokens,
    totalTokens: prev.totalTokens + usage.totalTokens,
    promptCacheHitTokens: prev.promptCacheHitTokens + usage.promptCacheHitTokens,
    promptCacheMissTokens: prev.promptCacheMissTokens + usage.promptCacheMissTokens,
  };
}

// ── Tool registry ──

export const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a file or list a directory's contents. Returns the file text with line numbers, "
      + "or a directory listing showing files and subdirectories. "
      + "For large files, use offset and limit to paginate — e.g. offset=100 limit=50 reads lines 100-149. "
      + "For structural queries (what exports X? who imports from Y?), use read_graph instead.",
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
      + "Use this to find where a function, class, variable, or string is used. "
      + "For dependency queries (what depends on X? what does Y import?), prefer read_graph — it's faster and doesn't scan file contents.",
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
    name: "kill_terminal",
    description:
      "Kill a terminal session started with run_in_terminal. "
      + "If no index is provided, kills ALL agent-spawned terminals. "
      + "Use index=N to kill a specific terminal (0 = first one spawned, 1 = second, etc.). "
      + "Agent-spawned terminals are tracked separately from user/IDE terminals — the count reported only includes agent terminals. "
      + "Prefer kill_terminal without index to clean up everything before task_complete.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "Optional: index of the terminal to kill (0-based). If omitted, kills ALL agent terminals." },
      },
      required: [],
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
      + "On Windows, the terminal is PowerShell. Do NOT use bash syntax: \`&&\` does NOT work (use \`;\` to chain commands), \`2>&1\` does NOT work (stderr is captured automatically). "
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
    name: "browser_console",
    description:
      "Get the last 50 console entries (log, warn, error, dialog) from the page. "
      + "Use this to check for JavaScript errors, warnings, or debug output. "
      + "Also captures alert/confirm/prompt dialogs as [DIALOG] entries. "
      + "Returns one entry per line in [LEVEL] text format.",
    parameters: { type: "object", properties: {}, required: [] },
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
    name: "write_summary",
    description:
      "Write the final structured summary for this task. This is REQUIRED before task_complete. Use this exact template:\n"
      + "### Changes Made\n"
      + "- [file path]: [what was changed]\n"
      + "### Verification\n"
      + "- [build/test/check result]\n"
      + "### Outcome\n"
      + "- [concise description of what was accomplished]\n\n"
      + "If you created a todo list with write_todos, you MUST also include:\n"
      + "### Todo Progress\n"
      + "- [id]: [status] — [what was done for this item]\n"
      + "(repeat for each todo item, listing its final status)\n\n"
      + "Do NOT write a thought process or narrative. Only the template.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Structured summary using the required template." },
      },
      required: ["summary"],
    },
  },
  {
    name: "task_complete",
    description:
      "Finalize the task. REQUIRED: call write_summary first, then call task_complete. "
      + "task_complete has no parameters and will be rejected if write_summary has not been called.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "delegate_task",
    description:
      "Delegate a sub-task to a specialized sub-agent that runs independently with its own context window. "
      + "The sub-agent works in isolation — its conversation does not bloat your context. "
      + "Use this for complex sub-tasks that would take many turns on their own, such as: "
      + "deep codebase research, implementing a self-contained feature, fixing a bug across multiple files, "
      + "or exploring an unfamiliar codebase. "
      + "Available agent types:\n"
      + "- 'browser': interact with a web page — navigate, click, type, inspect DOM, check console (full browser automation)\n"
      + "- 'code-search': find and read code, report findings (read-only, no edits)\n"
      + "- 'code-writer': implement changes, run builds, fix errors\n"
      + "- 'researcher': explore the codebase and answer questions\n"
      + "Returns a summarized result.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear, self-contained description of what the sub-agent should accomplish. Include specifics like file names, requirements, or questions." },
        agent_type: { type: "string", enum: ["browser", "code-search", "code-writer", "researcher"], description: "Type of sub-agent to spawn." },
      },
      required: ["task", "agent_type"],
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
    name: "read_graph",
    description:
      "Query the codebase knowledge graph. The graph tracks every file, directory, exported symbol "
      + "(functions, classes, types, etc.), and their relationships (CONTAINS, EXPORTS, IMPORTS, IMPORTS_SYMBOL). "
      + "Use this for structural/dependency questions — it's faster than grepping or reading files. "
      + "For file contents, use read_file. For content search, use grep. "
      + "Query types:\n"
      + "- 'structure' — print the full directory tree. Use this FIRST for architecture/overview questions ('describe this project', 'what's the project layout?').\n"
      + "- 'exports <file>' — list all symbols exported by a file (functions, classes, consts, types, interfaces, enums)\n"
      + "- 'imports_of <file>' — list all symbols imported by a file (with their source files)\n"
      + "- 'exporters_of <symbol>' — find which files export a symbol with this name\n"
      + "- 'dependents <file>' — find which files import from this file",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query string in the format '<query_type> <target>'. Examples: 'exports server/fileTracking.ts', 'exporters_of getFileTrackingService', 'imports_of client/src/App.tsx'." },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Store a key decision, user preference, project convention, or important fact for cross-session recall. "
      + "Use this proactively when the user makes a decision (e.g. 'let's use Preact instead of React'), "
      + "states a preference (e.g. 'I prefer tabs over spaces'), establishes a convention, or when you discover "
      + "an important project detail that will be useful in future sessions. Memories persist across sessions via SQLite. "
      + "Categories: 'decision', 'preference', 'convention', 'fact', 'pattern', or 'general'. "
      + "Tags help group related memories (comma-separated, e.g. 'react,styling,architecture').",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unique key/identifier for this memory (e.g. 'ui-framework', 'indent-style', 'api-auth-method')." },
        value: { type: "string", description: "The information to remember. Be specific and detailed." },
        category: { type: "string", enum: ["decision", "preference", "convention", "fact", "pattern", "general"], description: "Category of this memory." },
        tags: { type: "string", description: "Comma-separated tags for grouping (e.g. 'react,frontend,styling')." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "recall",
    description:
      "Search stored memories by semantic meaning or exact key. Use this at the start of a session or task "
      + "to recall user preferences, past decisions, and project conventions. "
      + "Results are ordered by relevance. If no query/key provided, lists all memories.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find relevant memories (semantic search if embeddings available, keyword fallback otherwise)." },
        key: { type: "string", description: "Exact key to retrieve a specific memory. Overrides query if both provided." },
        limit: { type: "integer", description: "Max results to return (default: 5, max: 20)." },
      },
      required: [],
    },
  },
  {
    name: "forget",
    description:
      "Remove a stored memory by its key. Use this when a decision is reversed, a preference changes, "
      + "or stored information becomes outdated.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key of the memory to remove." },
      },
      required: ["key"],
    },
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
  if (name === "read_graph") {
    return runGraphQuery(String(params.query || ""), root);
  }
  return null; // not a filesystem tool
}

// ── Knowledge Graph Query ──

function runGraphQuery(query: string, projectRoot: string): string {
  const hash = crypto.createHash("md5").update(path.resolve(projectRoot)).digest("hex").slice(0, 12);
  const kgDir = path.resolve(os.homedir(), ".harness");
  const kgPath = path.join(kgDir, `file-tree-snapshot-${hash}.kg`);

  if (!fs.existsSync(kgPath)) {
    return "Knowledge graph not built yet. Open the project folder in Harness to generate it.";
  }

  const raw = fs.readFileSync(kgPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));

  // ── Parse nodes ──
  const nodes = new Map<string, { type: string; parentId: string; name: string; kind: string }>();
  for (const line of lines) {
    if (!line.startsWith("n")) continue;
    const parts = line.split("|");
    if (parts.length < 6) continue;
    nodes.set("n" + parts[0].slice(1), {
      type: parts[1], parentId: parts[2] ? "n" + parts[2] : "", name: parts[4], kind: parts[5],
    });
  }

  // ── Parse edges + build O(1) indexes ──
  // fromIndex: key = "TYPE|fromId" → edges
  const fromIndex = new Map<string, Array<{ to: string; type: string }>>();
  // toIndex: key = "TYPE|toId" → fromIds
  const toIndex = new Map<string, string[]>();
  function indexEdge(key: string, fromId: string, toId: string, type: string): void {
    const fk = type + "|" + fromId;
    let arr = fromIndex.get(fk);
    if (!arr) { arr = []; fromIndex.set(fk, arr); }
    arr.push({ to: toId, type });
    const tk = type + "|" + toId;
    let tarr = toIndex.get(tk);
    if (!tarr) { tarr = []; toIndex.set(tk, tarr); }
    tarr.push(fromId);
  }
  for (const line of lines) {
    if (!line.startsWith("e")) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    // e<fromSeq>|<fromId>|<toId>|<type>
    const fromId = "n" + parts[0].slice(1);
    const toId = parts[2];
    const type = parts[3];
    indexEdge(parts[0], fromId, toId, type);
  }

  // ── Pre-resolve all paths (one recursive walk per node, cached) ──
  const pathCache = new Map<string, string>();
  const resolvePath = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached !== undefined) return cached;
    const node = nodes.get(id);
    if (!node) { pathCache.set(id, ""); return ""; }
    if (!node.parentId) { pathCache.set(id, node.name); return node.name; }
    const parentPath = resolvePath(node.parentId);
    const p = parentPath ? parentPath + "/" + node.name : node.name;
    pathCache.set(id, p);
    return p;
  };

  // ── Pre-resolve all file paths into a lowercase map for O(1) lookup ──
  const filePaths = new Map<string, string>(); // id → resolvedPath (lowercased)
  for (const [id, node] of nodes) {
    if (node.type === "file") {
      filePaths.set(id, resolvePath(id).toLowerCase());
    }
  }

  // ── Symbol name index: name.toLowerCase() → [{ id, parentId, name, kind }] ──
  const symbolIndex = new Map<string, Array<{ id: string; parentId: string; name: string; kind: string }>>();
  for (const [id, node] of nodes) {
    if (node.type !== "symbol") continue;
    const key = node.name.toLowerCase();
    let arr = symbolIndex.get(key);
    if (!arr) { arr = []; symbolIndex.set(key, arr); }
    arr.push({ id, parentId: node.parentId, name: node.name, kind: node.kind });
  }

  // ── Helper: find file node ID by path substring ──
  const qLower = (s: string) => s.toLowerCase();
  const findFileId = (target: string): string | null => {
    const t = qLower(target);
    for (const [id, fpath] of filePaths) {
      if (fpath.includes(t)) return id;
    }
    return null;
  };

  // ── Parse query ──
  const trimmed = query.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const qType = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx).toLowerCase() : trimmed.toLowerCase();
  const qTarget = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

  if (qType === "structure") {
    const dirPaths: string[] = [];
    for (const [id, node] of nodes) {
      if (node.type === "dir" || node.type === "file") {
        dirPaths.push(resolvePath(id));
      }
    }
    dirPaths.sort();
    return `Directory tree (${dirPaths.length} entries):\n${dirPaths.join("\n")}`;
  }

  if (qType === "exports") {
    const fileId = findFileId(qTarget);
    if (!fileId) return `File not found in graph: ${qTarget}`;
    const symEdges = fromIndex.get("EXPORTS|" + fileId) || [];
    if (symEdges.length === 0) return `${resolvePath(fileId)} exports nothing (or is not a TypeScript file).`;
    const syms = symEdges.map((e) => {
      const sym = nodes.get(e.to);
      return sym ? `${sym.name}:${sym.kind}` : "?";
    });
    return `${resolvePath(fileId)} exports:\n${syms.join("\n")}`;
  }

  if (qType === "exporters_of") {
    const matches = symbolIndex.get(qLower(qTarget));
    if (!matches || matches.length === 0) return `No symbol named '${qTarget}' found in the graph.`;
    const results = matches.map((s) => `${resolvePath(s.parentId)} → ${s.name}:${s.kind}`);
    return `Files exporting '${qTarget}':\n${results.join("\n")}`;
  }

  if (qType === "imports_of") {
    const fileId = findFileId(qTarget);
    if (!fileId) return `File not found in graph: ${qTarget}`;
    const symImports = fromIndex.get("IMPORTS_SYMBOL|" + fileId) || [];
    const fileImports = fromIndex.get("IMPORTS|" + fileId) || [];
    const parts: string[] = [];
    if (symImports.length > 0) {
      parts.push("Symbol-level imports:");
      for (const e of symImports) {
        const sym = nodes.get(e.to);
        const fpath = sym ? resolvePath(sym.parentId) : "?";
        parts.push(`  ${sym?.name || "?"} from ${fpath}`);
      }
    }
    if (fileImports.length > 0) {
      parts.push(`File-level imports (${fileImports.length}):`);
      for (const e of fileImports) {
        parts.push(`  ${resolvePath(e.to)}`);
      }
    }
    if (parts.length === 0) return `${resolvePath(fileId)} imports nothing.`;
    return `${resolvePath(fileId)} imports:\n${parts.join("\n")}`;
  }

  if (qType === "dependents") {
    const fileId = findFileId(qTarget);
    if (!fileId) return `File not found in graph: ${qTarget}`;
    const allDeps = new Set<string>();
    // Direct file-level & symbol-level imports where target file is the TO
    for (const key of ["IMPORTS|" + fileId, "IMPORTS_SYMBOL|" + fileId]) {
      for (const fromId of toIndex.get(key) || []) allDeps.add(fromId);
    }
    // Indirect: files that import symbols exported by the target file
    const exportedEdges = fromIndex.get("EXPORTS|" + fileId) || [];
    for (const e of exportedEdges) {
      for (const fromId of toIndex.get("IMPORTS_SYMBOL|" + e.to) || []) {
        allDeps.add(fromId);
      }
    }
    if (allDeps.size === 0) return `No files depend on ${resolvePath(fileId)}.`;
    const depList = [...allDeps].map((id) => resolvePath(id)).sort();
    return `${resolvePath(fileId)} is imported by:\n${depList.join("\n")}`;
  }

  return `Unknown query type '${qType}'. Valid types: 'exports <file>', 'imports_of <file>', 'exporters_of <symbol>', 'dependents <file>', 'structure'.`;
}

// ── Memory tools ──
// Handles remember, recall, forget — backed by SQLite with optional embeddings.

async function runMemoryTool(
  name: string,
  params: Record<string, unknown>,
  _projectRoot: string,
  apiKey: string,
): Promise<string> {
  const store = getMemoryStore();

  if (name === "remember") {
    const key = String(params.key || "").trim();
    const value = String(params.value || "");
    const category = String(params.category || "general");
    const tagsStr = String(params.tags || "");
    const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : [];

    if (!key) return "Error: 'key' is required for remember.";
    if (!value) return "Error: 'value' is required for remember.";

    // Try to generate an embedding for semantic search
    let embedding: Float32Array | undefined;
    try {
      const emb = await generateEmbedding(value, apiKey);
      if (emb) embedding = emb;
    } catch { /* embedding generation is optional */ }

    store.remember(key, value, category, tags, embedding);
    const total = store.count();
    return `Stored memory "${key}" (${category})${embedding ? " with embedding" : ""}. Total memories: ${total}.`;
  }

  if (name === "recall") {
    const exactKey = params.key ? String(params.key).trim() : null;
    const query = params.query ? String(params.query).trim() : null;
    const limit = Math.min(Math.max(1, Number(params.limit) || 5), 20);

    // Exact key lookup
    if (exactKey) {
      const entry = store.recallByKey(exactKey);
      if (!entry) return `No memory found with key "${exactKey}".`;
      return formatMemoryEntry(entry);
    }

    // Semantic / keyword search
    if (query) {
      // Try embedding-based search first if available
      try {
        const emb = await generateEmbedding(query, apiKey);
        if (emb && store.hasEmbeddings()) {
          const results = store.searchByEmbedding(emb, limit);
          if (results.length > 0) {
            return formatMemoryResults(results, "semantic");
          }
        }
      } catch { /* fall through to keyword search */ }

      const results = store.searchByKeyword(query, limit);
      if (results.length === 0) return `No memories found matching "${query}".`;
      return formatMemoryResults(results, "keyword");
    }

    // No query or key — list all
    const all = store.list();
    if (all.length === 0) return "No memories stored yet. Use remember to store important decisions, preferences, and conventions.";
    const recent = all.slice(0, limit);
    return formatMemoryResults(recent, "recent");
  }

  if (name === "forget") {
    const key = String(params.key || "").trim();
    if (!key) return "Error: 'key' is required for forget.";
    const deleted = store.forget(key);
    return deleted
      ? `Deleted memory "${key}".`
      : `No memory found with key "${key}". Nothing deleted.`;
  }

  return `Unknown memory tool: ${name}`;
}

function formatMemoryEntry(e: { key: string; value: string; category: string; tags: string; createdAt: string }): string {
  const parts = [`Key: ${e.key}`, `Category: ${e.category}`];
  if (e.tags) parts.push(`Tags: ${e.tags}`);
  parts.push(`Stored: ${e.createdAt}`);
  parts.push(`Value: ${e.value}`);
  return parts.join("\n");
}

function formatMemoryResults(results: Array<{ key: string; value: string; category: string; tags: string; score?: number; createdAt: string }>, mode: string): string {
  const total = results.length;
  const header = total === 1
    ? `1 memory found (${mode} search):`
    : `${total} memories found (${mode} search):`;
  const items = results.map((r, i) => {
    const score = r.score != null ? ` [score: ${r.score.toFixed(2)}]` : "";
    const tags = r.tags ? ` [${r.tags}]` : "";
    return `${i + 1}. ${r.key} (${r.category})${tags}${score}\n   ${r.value.slice(0, 200)}${r.value.length > 200 ? "..." : ""}`;
  });
  return [header, ...items].join("\n\n");
}

// ── Agent loop ──

const MAX_ITERATIONS = 50;
const HISTORY_COMPACTION_TRIGGER_MESSAGES = 60;
const HISTORY_COMPACTION_TRIGGER_TOKENS = 20_000;
const HISTORY_PLAIN_MESSAGES_TO_KEEP = 15;
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

function estimateStateTokens(state: Pick<AgentState, "messages" | "historySummary">, systemPromptChars = 0): number {
  const totalChars = state.messages.reduce((sum, m) =>
    sum + (m.content?.length || 0) + (m.tool_call_id?.length || 0) + (m.name?.length || 0) + (m.reasoning_content?.length || 0), 0)
    + (state.historySummary?.length || 0)
    + systemPromptChars;
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

  const beforeCount = state.messages.length;
  const beforeEstTokens = estimateStateTokens(state);
  state.historySummary = mergeHistorySummary(state.historySummary, compactedMessages);
  state.messages = state.messages.filter((_, index) => !indexesToCompact.has(index));
  const afterCount = state.messages.length;
  const summaryChars = state.historySummary?.length || 0;
  const afterEstTokens = estimateStateTokens(state);
  const savedTokens = beforeEstTokens - afterEstTokens;
  console.log(`[compact] messages ${beforeCount} → ${afterCount} (compacted ${compactedMessages.length}) | ~${beforeEstTokens} → ~${afterEstTokens} tokens (saved ~${savedTokens}) | summary ${summaryChars} chars${overMessageLimit ? " [msg trigger]" : ""}${overTokenLimit ? " [token trigger]" : ""}`);
}

function extractCommandId(text: string): number | null {
  const match = text.match(/\[cmd #(\d+)\]/);
  return match ? Number(match[1]) : null;
}

export function summarizeCommandResult(raw: string, label: string): string {
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

  // Build a map of tool_call_id → content from all tool messages in state.
  // This lets us emit tool responses immediately after their assistant message,
  // regardless of where the tool message appears in state.messages order.
  // DeepSeek requires each assistant(tool_calls) to be immediately followed
  // by tool messages for all its tool_call_ids — no intervening messages.
  const toolResults = new Map<string, string>();
  for (const message of state.messages) {
    if (message.role === "tool") {
      const toolId = message.tool_call_id;
      if (toolId && !toolResults.has(toolId)) {
        toolResults.set(toolId, message.content);
      }
    }
  }

  const consumedIds = new Set<string>();

  for (const message of state.messages) {
    // Tool messages are handled inline by the assistant that issued them —
    // skip standalone tool messages to avoid duplicates.
    if (message.role === "tool") {
      continue;
    }

    if (message.role === "assistant" && message.name) {
      try {
        const calls: Array<{ id?: string }> = JSON.parse(message.content);
        const ids = calls.map((call) => call.id).filter(Boolean) as string[];
        msgs.push({
          role: "assistant",
          content: null,
          tool_calls: calls,
          ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        });
        // Emit tool responses immediately after the assistant message,
        // ensuring DeepSeek's required message ordering.
        for (const id of ids) {
          const result = !consumedIds.has(id) ? toolResults.get(id) : undefined;
          consumedIds.add(id);
          msgs.push({
            role: "tool",
            content: result ?? `ERROR: Tool execution failed or was interrupted. Do not retry — the state may be inconsistent.`,
            tool_call_id: id,
          });
        }
      } catch {
        msgs.push({
          role: "assistant",
          content: message.content,
          ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        });
      }
      continue;
    }

    msgs.push(message);
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
1. **Break the user's request into steps and use \`write_todos\` to plan.** Your first action MUST be to create a todo list. Each item must be a concrete, verifiable step.
2. **Work through todos one at a time.** Focus ONLY on the current pending/in_progress item. Do not jump ahead or work on multiple items at once.
3. **Update todos after EVERY step.** After completing a tool call that moves the current item forward, call \`write_todos\` again with the updated status. Mark the item \`completed\` if done, or keep it \`in_progress\`. This keeps the user informed of your progress.
4. **ALL items must be \`completed\` or \`cancelled\` before you can finish.** \`write_todos\` is a tracking tool, NOT a terminal action — updating todos does not finish the task. You MUST continue to the next item.
5. Use tools one at a time. After each tool call, read the result before deciding the next step.
6. **When all items are done, call \`write_summary\` (structured template), then call \`task_complete\`.** NEVER stop the conversation without calling \`task_complete\`. Writing todos alone does NOT finish the task.
7. If you encounter an error, explain what happened and suggest how to fix it.
8. Keep responses concise — one sentence of reasoning, one tool call.
9. Do NOT guess browser DOM indices — call \`browser_get_dom\` first.
10. **Before interacting with a web app in the browser, you MUST start the server first.** Use \`run_in_terminal\` to start the server, wait for the user to Allow the command. Then CHECK THE TERMINAL OUTPUT for runtime errors BEFORE navigating to the browser. Only call \`browser_info\` after confirming the terminal output shows no errors.
11. **Browser interactions MUST be delegated to a sub-agent.** Use \`browser_navigate\`, \`browser_info\`, \`browser_screenshot\`, and \`browser_get_dom\` for observation only. For ANY interactive actions (clicking, typing, scrolling, selecting, pressing keys), call \`delegate_task agent_type: "browser"\` with a clear description. The sub-agent returns a summary.
12. After starting a server, do NOT guess the URL or port. Call \`browser_info\` to check if a tab opened. If none, ask the user for the URL.
13. Only use tools from the registry. NEVER invent tools — use \`read_file\` (not cat/head/tail), \`list_files\` (not ls/dir), \`search_files\` (not find/locate), \`grep\` (the tool, not the shell command), \`edit_file\` (not sed/awk), \`write_file\` (not echo>/cp), \`run_command\` for short commands, \`run_in_terminal\` for servers.

### Persistent Memory
- Use \`remember\` to store important decisions, user preferences, project conventions, and discovered patterns. Memories survive across sessions (SQLite-backed). Be proactive — when the user says "let's use X", "I prefer Y", or establishes a convention, store it.
- Use \`recall\` at the start of a session or task to retrieve relevant past memories. Search by semantic meaning or exact key.
- Use \`forget\` to remove outdated or incorrect memories when preferences change.

### Tool priority
When exploring an unfamiliar project or answering structural questions, follow this order:
1. **\`read_graph structure\`** — always start here to see the project layout. Use it FIRST for any architecture/structure/overview question.
2. **\`read_graph exports <file>\` / \`read_graph dependents <file>\`** — next, check what key files export and how they connect.
3. **\`read_file\` / \`grep\`** — only then read file contents or search for specific code. \`read_graph\` answers structural questions without scanning files.

### File conventions
- All file paths are relative to the project root.
- Use \`read_file\` to see existing code before editing it.
- PREFER \`edit_file\` for any change to an existing file — only send the exact lines that change. old_string must match exactly including whitespace/indentation. If it matches multiple locations, set replace_all to true or make it more specific. This is much cheaper (fewer tokens) and preserves the file's history.
- Use \`write_file\` ONLY for creating a brand-new file, or when the entire file needs to be rewritten from scratch.
- Use \`list_files\` to browse a specific directory.
- Use \`search_files\` to find any file or folder anywhere in the project (by name pattern).
- Use \`grep\` to search file contents for a string or regex — find definitions, usages, references.
- Use \`read_graph\` for dependency/structural queries — \`read_graph structure\` to understand project layout/architecture before browsing files, \`read_graph exports <file>\` to see what a file exports, \`read_graph dependents <file>\` to find who imports from it. Much faster than grep for these questions.

Current time: ${new Date().toISOString()}`;

const BROWSER_USAGE = `### Browser usage
- Use \`browser_navigate\` to go to a URL, \`browser_info\` to check the current tab state.
- Use \`browser_screenshot\` for a quick page overview (URL, title, element grid, errors). Use \`browser_get_dom\` for the full indexed element listing.
- Use \`browser_console\` and \`browser_request_errors\` to check for errors or failed requests.
- **All interactive browser actions** (clicking, typing, scrolling, selecting, pressing keys, uploading files) are ONLY available to the browser sub-agent. You do NOT have these tools — delegate via \`delegate_task agent_type: "browser"\`. The sub-agent returns a concise summary.

### DOM output format (browser_get_dom / browser_screenshot)
Both tools return elements in a standardized position-stable grid:
\`\`\`
V:1920x1080
---
TL|2
  0|button#login "Login" A+ 50,20:100x40 ^form#login
  1|input#user[text] "Username" A+ 50,70:200x30 ^form#login
TC|3
  2|input#pass[password] A+ 50,110:200x30 ^form#login
  3|h1 "Welcome" 800,30:320x50
  4|a#help "Help" A 1800,30:80x30 ^nav
\`\`\`
Each line: \` NN|tag#id[type] "label" FLAGS x,y:WxH ^ctx\`
- \`NN\` = index to pass to click/type/select/upload/right_click
- \`A\` = clickable, \`A+\` = interactive (input/select/textarea/button)
- Other FLAGS: \`disabled\` \`checked\` \`readonly\` \`required\`
- Indices are sorted top-to-bottom, left-to-right (pure geometry, stable across re-calls).
- Look for \`A\` / \`A+\` to identify interactive elements.`;

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
  const selectedChunks: string[] = [];
  const skippedChunks: string[] = [];
  for (const chunk of PROMPT_CHUNKS) {
    if (chunk.always) {
      parts.push(chunk.content);
      selectedChunks.push(chunk.id);
      continue;
    }
    const score = countTriggers(combined, chunk.triggers);
    // Browser chunk also activates when any browser_* tool has been called
    const browserBoost = (chunk.id === "browser" && toolNames.some((n) => n.startsWith("browser_"))) ? 5 : 0;
    if (score >= 2 || browserBoost > 0) {
      parts.push(chunk.content);
      selectedChunks.push(`${chunk.id}(s:${score}${browserBoost ? `+b${browserBoost}` : ""})`);
    } else {
      skippedChunks.push(`${chunk.id}(s:${score})`);
    }
  }

  // Append IDE context if provided
  if (context && context.trim()) {
    parts.push(`### Additional context from the IDE\n${context}`);
  }

  const result = parts.join("\n\n");
  const totalChars = result.length;
  const estTokens = Math.round(totalChars / 4);
  console.log(`[ITR] prompt: ${totalChars} chars (~${estTokens} tokens) | ${selectedChunks.length + 1} chunks selected${skippedChunks.length > 0 ? `, ${skippedChunks.length} skipped` : ""}`);
  if (skippedChunks.length > 0) {
    console.log(`[ITR]   included: ${selectedChunks.join(", ")}`);
    console.log(`[ITR]   skipped:  ${skippedChunks.join(", ")}`);
  }
  return result;
}

let callSeq = 0;

// ── Sub-Agent Runner ──

function buildOpenAiMessagesForSubAgent(
  state: AgentState,
  customSystemPrompt: string,
): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: "system", content: customSystemPrompt }];

  // Build a map of tool_call_id → content from all tool messages in state.
  // This lets us emit tool responses immediately after their assistant message,
  // regardless of where the tool message appears in state.messages order.
  // DeepSeek requires each assistant(tool_calls) to be immediately followed
  // by tool messages for all its tool_call_ids — no intervening messages.
  const toolResults = new Map<string, string>();
  for (const m of state.messages) {
    if (m.role === "tool") {
      const id = m.tool_call_id;
      if (id && !toolResults.has(id)) {
        toolResults.set(id, m.content);
      }
    }
  }

  const consumedIds = new Set<string>();

  for (const m of state.messages) {
    // Tool messages are handled inline by the assistant that issued them —
    // skip standalone tool messages to avoid duplicates.
    if (m.role === "tool") {
      continue;
    }
    if (m.role === "assistant" && m.name) {
      try {
        const calls: Array<{ id?: string }> = JSON.parse(m.content);
        const ids = calls.map((call) => call.id).filter(Boolean) as string[];
        msgs.push({
          role: "assistant",
          content: null,
          tool_calls: calls,
          ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
        });
        // Emit tool responses immediately after the assistant message,
        // ensuring DeepSeek's required message ordering.
        for (const id of ids) {
          const result = !consumedIds.has(id) ? toolResults.get(id) : undefined;
          consumedIds.add(id);
          msgs.push({
            role: "tool",
            content: result ?? "ERROR: Sub-agent tool execution failed.",
            tool_call_id: id,
          });
        }
      } catch {
        msgs.push({
          role: "assistant",
          content: m.content,
          ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
        });
      }
      continue;
    }
    msgs.push({
      role: m.role as "user" | "assistant",
      content: m.content,
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    });
  }

  return msgs;
}

function summarizeSubAgentResult(rawResult: string, agentName: string): string {
  const lines = rawResult.split("\n").filter(Boolean);
  const importantLines = lines.filter((l, i) =>
    i < 3 || /(file|change|error|fix|wrote|edited|created|deleted|found|modified)/i.test(l),
  );
  const summary = importantLines.slice(0, 15).join("\n");
  if (summary.length < rawResult.length) return `${summary}\n... (full: ${lines.length} lines)`;
  return summary;
}

// ── Summary validation: reject vague "thought process" style summaries ──
function isVagueSummary(summary: string): string | null {
  const s = summary.trim();
  // Common "thought process" patterns that indicate no real structure
  const thoughtPatterns = [
    /^OK\.?\s*$/i,
    /^Done\.?\s*$/i,
    /^I (have|did|completed|finished|made|updated|changed|added|removed)/i,
    /^(OK|Alright|Sure|Got it),?\s/i,
    /^The (task|step|change|request|user)/i,
    /^Task completed/i,
    /^Here('| i)s (what|a summary)/i,
  ];
  const hasTemplateHeader = /(?:###\s*Changes\s*Made|###\s*Verification|###\s*Outcome|\*\*Changes\s*Made\*\*|\*\*Verification\*\*|\*\*Outcome\*\*|-\s*\[.*\]\s*:)/i.test(s);
  // Check thought patterns — only override if template headers exist
  for (const pat of thoughtPatterns) {
    if (pat.test(s) && !hasTemplateHeader) {
      return `Summary looks like a thought process, not a structured summary. Use the exact template:\n### Changes Made\n- [file path]: [what was changed]\n### Verification\n- [build/test/check result]\n### Outcome\n- [concise description of what was accomplished]`;
    }
  }
  // Reject single-word or empty summaries
  if (s.length < 8) {
    return "Summary is too short. Use the template: ### Changes Made, ### Verification, ### Outcome.";
  }
  // Reject if no template headers and too short
  if (!hasTemplateHeader && s.length < 60) {
    return "Summary lacks concrete details (no file references, actions, or results). Use the template: ### Changes Made, ### Verification, ### Outcome.";
  }
  return null; // passes validation
}

function hasToolActivity(state: AgentState): boolean {
  return state.messages.some((m) => m.role === "tool");
}

function buildTaskCompleteReminder(state: AgentState, scope: "agent" | "sub-agent"): string {
  const todoRequirement = state.latestTodos && state.latestTodos.length > 0
    ? ` Your summary must include a "### Todo Progress" section covering every todo item's final status.`
    : "";
  return `Do not end with a plain assistant message. You must call write_summary, then task_complete, to finish this ${scope}.${todoRequirement} If you already wrote a summary in normal text, call write_summary with that summary using the required structured format, then call task_complete.`;
}

// ── Todo completion guard: detect pending tasks at task_complete ──
function getPendingTodos(state: AgentState): { id: string; text: string; status: string }[] | null {
  const todos = state.latestTodos;
  if (!todos || todos.length === 0) return null;
  const pending = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  return pending.length > 0 ? pending : null;
}

const BROWSER_TOOLS = new Set([
  "browser_info", "browser_screenshot", "browser_get_dom", "browser_console",
  "browser_request_errors", "browser_scroll", "browser_wait",
  "browser_click", "browser_type", "browser_navigate",
  "browser_move_mouse", "browser_right_click", "browser_press_key",
  "browser_select", "browser_clear", "browser_upload_file",
]);

type SubAgentResult =
  | { phase: "done"; success: boolean; summary: string; iterations: number; subState: AgentState }
  | { phase: "browser_tool"; toolName: string; toolCallId: string; params: Record<string, unknown>; subState: AgentState };

type SubAgentStreamEvent = AgentSseEvent & { agentMarker?: string };

function isBrowserTool(name: string): boolean {
  return BROWSER_TOOLS.has(name);
}

// Streaming sub-agent: yields tool_start/tool_end events for live UI.
// Returns a SubAgentResult when complete (done or browser_tool pause).
async function* runSubAgentStream(
  parentState: AgentState,
  task: string,
  config: SubAgentConfig,
  agentMarker: string,
  modelOpts: { model?: string; apiKey: string },
): AsyncGenerator<SubAgentStreamEvent, SubAgentResult, undefined> {
  const maxIter = config.maxIterations || 15;

  // Prepend shared prefix from previous delegations of the same type
  const prefix = agentMarker ? (parentState.subAgentPrefix || (parentState.subAgentPrefix = {}))[agentMarker] || [] : [];
  const subState: AgentState = {
    messages: [...prefix, { role: "user" as const, content: task }],
    iteration: 0,
    projectRoot: parentState.projectRoot,
  };

  const allowedSet = config.tools ? new Set(config.tools) : null;
  const subTools = config.headless
    ? TOOLS.filter((t) => (allowedSet ? allowedSet.has(t.name) : true) && !t.name.startsWith("browser_") && t.name !== "run_in_terminal" && t.name !== "task_complete" && t.name !== "write_summary")
    : allowedSet ? TOOLS.filter((t) => allowedSet.has(t.name) && t.name !== "task_complete" && t.name !== "write_summary") : TOOLS.filter((t) => t.name !== "task_complete" && t.name !== "write_summary");

  const systemPrompt = config.systemPrompt || "";
  const rc = (reasoning: string | null | undefined) =>
    reasoning ? { reasoning_content: reasoning } : {};
  for (let iter = 0; iter < maxIter; iter++) {
    subState.iteration++;
    const openaiMessages = buildOpenAiMessagesForSubAgent(subState, systemPrompt);
    const { text, toolCalls, reasoningContent } = await chatDeepSeekTool(openaiMessages, subTools, modelOpts);

    if (!toolCalls || toolCalls.length === 0) {
      const reply = text || "Done.";
      subState.messages.push({ role: "assistant", content: reply, ...rc(reasoningContent) });
      yield { type: "text", text: reply } as SubAgentStreamEvent;
      const summary = summarizeSubAgentResult(reply, config.name);
      return { phase: "done", success: true, summary, iterations: iter + 1, subState };
    }

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      // Browser tool — pause sub-agent and yield to parent renderer
      if (isBrowserTool(fnName)) {
        subState.messages.push({
          role: "assistant",
          content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
          name: fnName,
          ...rc(reasoningContent),
        });
        yield { type: "tool_start", toolName: fnName, toolParams: params, toolCallId: tc.id, agentMarker } as SubAgentStreamEvent;
        return { phase: "browser_tool", toolName: fnName, toolCallId: tc.id, params, subState };
      }

      // Yield tool_start with agent marker
      subState.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
        name: fnName,
        ...rc(reasoningContent),
      });
      yield { type: "tool_start", toolName: fnName, toolParams: params, toolCallId: tc.id, agentMarker } as SubAgentStreamEvent;

      const fsResult = await runFsTool(fnName, params, subState.projectRoot);
      if (fsResult !== null) {
        const stored = fnName === "run_command" ? summarizeCommandResult(fsResult, "Sub-agent command") : fsResult;
        subState.messages.push({ role: "tool", content: stored, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: stored.slice(0, 2000), agentMarker, toolSandbox: fnName === "run_command" ? stored : undefined } as SubAgentStreamEvent;
      } else if (fnName === "read_problems") {
        const diag = await runReadProblems(subState.projectRoot);
        subState.messages.push({ role: "tool", content: diag.summary, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: diag.summary, agentMarker } as SubAgentStreamEvent;
      } else if (fnName === "task_complete") {
        const notAllowed = `Tool "${fnName}" is not available to sub-agents. Return your final report as plain text instead.`;
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: notAllowed, agentMarker } as SubAgentStreamEvent;
        continue;
      } else {
        subState.messages.push({
          role: "tool",
          content: `Tool "${fnName}" is not available to sub-agents.`,
          tool_call_id: tc.id,
        });
        yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: `Tool "${fnName}" is not available.`, agentMarker } as SubAgentStreamEvent;
      }
    }
  }

  return { phase: "done", success: false, summary: `Sub-agent reached max iterations (${maxIter}).`, iterations: maxIter, subState };
}

async function runSubAgent(
  parentState: AgentState,
  task: string,
  config: SubAgentConfig,
  modelOpts: { model?: string; apiKey: string },
  agentType?: string,
): Promise<SubAgentResult> {
  const maxIter = config.maxIterations || 15;

  // Prepend shared prefix from previous delegations of the same type
  const prefix = agentType ? (parentState.subAgentPrefix || (parentState.subAgentPrefix = {}))[agentType] || [] : [];
  const subState: AgentState = {
    messages: [...prefix, { role: "user" as const, content: task }],
    iteration: 0,
    projectRoot: parentState.projectRoot,
  };

  const allowedSet = config.tools ? new Set(config.tools) : null;
  const subTools = config.headless
    ? TOOLS.filter((t) => (allowedSet ? allowedSet.has(t.name) : true) && !t.name.startsWith("browser_") && t.name !== "run_in_terminal" && t.name !== "task_complete" && t.name !== "write_summary")
    : allowedSet ? TOOLS.filter((t) => allowedSet.has(t.name) && t.name !== "task_complete" && t.name !== "write_summary") : TOOLS.filter((t) => t.name !== "task_complete" && t.name !== "write_summary");

  const systemPrompt = config.systemPrompt || "";
  const rc = (reasoning: string | null | undefined) =>
    reasoning ? { reasoning_content: reasoning } : {};
  for (let iter = 0; iter < maxIter; iter++) {
    subState.iteration++;
    const openaiMessages = buildOpenAiMessagesForSubAgent(subState, systemPrompt);
    const { text, toolCalls, reasoningContent } = await chatDeepSeekTool(openaiMessages, subTools, modelOpts);

    if (!toolCalls || toolCalls.length === 0) {
      const reply = text || "Done.";
      subState.messages.push({ role: "assistant", content: reply, ...rc(reasoningContent) });
      const summary = summarizeSubAgentResult(reply, config.name);
      return { phase: "done", success: true, summary, iterations: iter + 1, subState };
    }

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      // Browser tool — pause sub-agent and yield to parent renderer
      if (isBrowserTool(fnName)) {
        subState.messages.push({
          role: "assistant",
          content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
          name: fnName,
          ...rc(reasoningContent),
        });
        // Push remaining tool calls as NOT_EXECUTED
        for (let j = 0; j < toolCalls.length; j++) {
          if (j !== toolCalls.indexOf(tc)) {
            const skipped = toolCalls[j];
            subState.messages.push({
              role: "assistant",
              content: JSON.stringify([{ id: skipped.id, type: "function", function: { name: skipped.function.name, arguments: skipped.function.arguments } }]),
              name: skipped.function.name,
              ...rc(reasoningContent),
            });
            subState.messages.push({
              role: "tool",
              content: "NOT_EXECUTED: batched with browser tool.",
              tool_call_id: skipped.id,
            });
          }
        }
        return { phase: "browser_tool", toolName: fnName, toolCallId: tc.id, params, subState };
      }

      subState.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
        name: fnName,
        ...rc(reasoningContent),
      });

      const fsResult = await runFsTool(fnName, params, subState.projectRoot);
      if (fsResult !== null) {
        const stored = fnName === "run_command" ? summarizeCommandResult(fsResult, "Sub-agent command") : fsResult;
        subState.messages.push({ role: "tool", content: stored, tool_call_id: tc.id });
      } else if (fnName === "read_problems") {
        const diag = await runReadProblems(subState.projectRoot);
        subState.messages.push({ role: "tool", content: diag.summary, tool_call_id: tc.id });
      } else if (fnName === "task_complete") {
        const notAllowed = `Tool "${fnName}" is not available to sub-agents. Return your final report as plain text instead.`;
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        continue;
      } else {
        subState.messages.push({
          role: "tool",
          content: `Tool "${fnName}" is not available to sub-agents.`,
          tool_call_id: tc.id,
        });
      }
    }
  }

  return { phase: "done", success: false, summary: `Sub-agent reached max iterations (${maxIter}).`, iterations: maxIter, subState };
}

/** Resume a paused sub-agent after a browser tool result has been received. */
export async function resumeSubAgent(
  subState: AgentState,
  config: SubAgentConfig,
  toolCallId: string,
  toolResult: string,
  modelOpts: { model?: string; apiKey: string },
): Promise<SubAgentResult> {
  const maxIter = config.maxIterations || 15;

  // Push the browser tool result
  subState.messages.push({ role: "tool", content: toolResult, tool_call_id: toolCallId });

  const allowedSet = config.tools ? new Set(config.tools) : null;
  const subTools = config.headless
    ? TOOLS.filter((t) => (allowedSet ? allowedSet.has(t.name) : true) && !t.name.startsWith("browser_") && t.name !== "run_in_terminal" && t.name !== "task_complete" && t.name !== "write_summary")
    : allowedSet ? TOOLS.filter((t) => allowedSet.has(t.name) && t.name !== "task_complete" && t.name !== "write_summary") : TOOLS.filter((t) => t.name !== "task_complete" && t.name !== "write_summary");

  const systemPrompt = config.systemPrompt || "";
  const rc = (reasoning: string | null | undefined) =>
    reasoning ? { reasoning_content: reasoning } : {};

  for (let iter = subState.iteration; iter < maxIter; iter++) {
    subState.iteration++;
    const openaiMessages = buildOpenAiMessagesForSubAgent(subState, systemPrompt);
    const { text, toolCalls, reasoningContent } = await chatDeepSeekTool(openaiMessages, subTools, modelOpts);

    if (!toolCalls || toolCalls.length === 0) {
      const reply = text || "Done.";
      subState.messages.push({ role: "assistant", content: reply, ...rc(reasoningContent) });
      const summary = summarizeSubAgentResult(reply, config.name);
      return { phase: "done", success: true, summary, iterations: iter + 1, subState };
    }

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      if (isBrowserTool(fnName)) {
        subState.messages.push({
          role: "assistant",
          content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
          name: fnName,
          ...rc(reasoningContent),
        });
        for (let j = 0; j < toolCalls.length; j++) {
          if (j !== toolCalls.indexOf(tc)) {
            const skipped = toolCalls[j];
            subState.messages.push({
              role: "assistant",
              content: JSON.stringify([{ id: skipped.id, type: "function", function: { name: skipped.function.name, arguments: skipped.function.arguments } }]),
              name: skipped.function.name,
              ...rc(reasoningContent),
            });
            subState.messages.push({ role: "tool", content: "NOT_EXECUTED: batched with browser tool.", tool_call_id: skipped.id });
          }
        }
        return { phase: "browser_tool", toolName: fnName, toolCallId: tc.id, params, subState };
      }

      subState.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
        name: fnName,
        ...rc(reasoningContent),
      });

      const fsResult = await runFsTool(fnName, params, subState.projectRoot);
      if (fsResult !== null) {
        const stored = fnName === "run_command" ? summarizeCommandResult(fsResult, "Sub-agent command") : fsResult;
        subState.messages.push({ role: "tool", content: stored, tool_call_id: tc.id });
      } else if (fnName === "read_problems") {
        const diag = await runReadProblems(subState.projectRoot);
        subState.messages.push({ role: "tool", content: diag.summary, tool_call_id: tc.id });
      } else if (fnName === "task_complete") {
        const notAllowed = `Tool "${fnName}" is not available to sub-agents. Return your final report as plain text instead.`;
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        continue;
      } else {
        subState.messages.push({ role: "tool", content: `Tool "${fnName}" is not available to sub-agents.`, tool_call_id: tc.id });
      }
    }
  }

  return { phase: "done", success: false, summary: `Sub-agent reached max iterations (${maxIter}).`, iterations: maxIter, subState };
}

// ═══════════════════════════════════════════════════════════════════
//  IDE-DRIVEN STEP-BY-STEP EXECUTION
//  The IDE locks the todo list after planning, then forces the agent
//  through each step one at a time via isolated sub-agents.
// ═══════════════════════════════════════════════════════════════════

// ── Planning-phase tools: only write_todos ──
const PLAN_ONLY_TOOLS: ToolDef[] = [
  {
    name: "write_todos",
    description:
      "Create a structured task list that breaks down the user's request into concrete, verifiable steps. "
      + "Each step should be actionable and self-contained. The IDE will execute each step one at a time "
      + "using a dedicated sub-agent. After calling this tool, your planning phase is complete.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full task list. Each item has id, text, and status (all should start as 'pending').",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier for the todo (e.g. '1', '2')." },
              text: { type: "string", description: "The task description — be specific and actionable." },
              status: { type: "string", enum: ["pending"], description: "All items must start as 'pending'." },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
];

// ── Planning-phase system prompt ──
const PLANNING_SYSTEM_PROMPT = `You are a planning specialist for a step-by-step IDE agent called Harness.

Your ONLY job is to break down the user's task into a sequence of concrete, self-contained steps.
Each step must be actionable by a code-writing sub-agent that has access to:
- Read files (read_file, list_files, search_files, grep)
- Edit files (write_file, edit_file, delete_file, rename_file, create_directory)
- Run commands (run_command, read_command_output)
- Check diagnostics (read_problems)

### Rules
1. **Call \`write_todos\` as your first and only action.** Create a detailed, sequenced plan.
2. Each todo item must be a concrete, verifiable step — not vague like "implement the feature", but specific like "Create the login form component in client/src/Login.tsx".
3. Order matters. Put prerequisite steps first (e.g., create types before functions, build backend before frontend).
4. Limit to 3–8 steps. Break complex tasks into manageable chunks.
5. Include a final verification step (e.g., "Run the build/tests and verify no errors").
6. Do NOT call any other tools. You are in the PLANNING phase. The IDE will execute each step for you.`;

// ── Streaming sub-agent runner for step-by-step execution ──
// Wraps runSubAgent to yield per-tool SSE events so the client sees progress.

interface StepSubAgentSseEvent extends AgentSseEvent {
  stepComplete?: { success: boolean; summary: string; iterations: number };
}

async function* runStepSubAgent(
  parentState: AgentState,
  task: string,
  config: SubAgentConfig,
  modelOpts: { model?: string; apiKey: string },
): AsyncGenerator<StepSubAgentSseEvent> {
  const maxIter = config.maxIterations || 25;

  const subState: AgentState = {
    messages: [{ role: "user", content: task }],
    iteration: 0,
    projectRoot: parentState.projectRoot,
  };

  const allowedSet = config.tools ? new Set(config.tools) : null;
  const subTools = config.headless
    ? TOOLS.filter((t) => (allowedSet ? allowedSet.has(t.name) : true) && !t.name.startsWith("browser_") && t.name !== "run_in_terminal")
    : allowedSet ? TOOLS.filter((t) => allowedSet.has(t.name)) : TOOLS;

  const systemPrompt = config.systemPrompt || "";
  const apiKey = modelOpts.apiKey;

  for (let iter = 0; iter < maxIter; iter++) {
    subState.iteration++;
    const openaiMessages = buildOpenAiMessagesForSubAgent(subState, systemPrompt);
    const modelOptsFull = { model: modelOpts.model, apiKey };

    // Use streaming for better UX
    const stream = chatDeepSeekToolStream(openaiMessages, subTools, modelOptsFull);
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
        finalToolCalls = chunk.toolCalls ?? null;
        streamDone = true;
      }
    }

    if (!streamDone) {
      yield {
        type: "step_end",
        stepTodo: undefined,
        toolResult: "Sub-agent stream interrupted.",
      } as AgentSseEvent;
      return;
    }

    // No tool calls — assistant text reply. End the step.
    if (!finalToolCalls || finalToolCalls.length === 0) {
      const reply = finalText || "Done.";
      subState.messages.push({ role: "assistant", content: reply, ...(finalReasoning ? { reasoning_content: finalReasoning } : {}) });
      const summary = summarizeSubAgentResult(reply, config.name);
      yield {
        type: "text", text: reply,
        stepComplete: { success: true, summary, iterations: iter + 1 },
      } as StepSubAgentSseEvent;
      return;
    }

    // Process tool calls
    for (const tc of finalToolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      yield { type: "tool_start", toolName: fnName, toolParams: params };

      // Browser tool — not allowed in step-by-step sub-agents
      if (isBrowserTool(fnName)) {
        const notAllowed = `Tool "${fnName}" is not available to step sub-agents. Use code-writer tools only.`;
        subState.messages.push({
          role: "assistant",
          content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
          name: fnName,
          ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
        });
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolResult: notAllowed };
        continue;
      }

      // run_in_terminal — not allowed in step-by-step
      if (fnName === "run_in_terminal") {
        const notAllowed = `Tool "${fnName}" requires user permission and is not available to step sub-agents. Use "run_command" instead.`;
        subState.messages.push({
          role: "assistant",
          content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
          name: fnName,
          ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
        });
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolResult: notAllowed };
        continue;
      }

      subState.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
        name: fnName,
        ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
      });

      if (fnName === "task_complete" || fnName === "write_summary") {
        const notAllowed = `Tool "${fnName}" is not available in step-by-step sub-agents. Return your final report as plain text instead.`;
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolResult: notAllowed };
        continue;
      }

      const fsResult = await runFsTool(fnName, params, subState.projectRoot);
      if (fsResult !== null) {
        const stored = fnName === "run_command" ? summarizeCommandResult(fsResult, "Sub-agent command") : fsResult;
        subState.messages.push({ role: "tool", content: stored, tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: stored.slice(0, 2000),
          toolSandbox: fnName === "run_command" ? fsResult : undefined,
        };
      } else if (fnName === "read_problems") {
        const diag = await runReadProblems(subState.projectRoot);
        subState.messages.push({ role: "tool", content: diag.summary, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolResult: diag.summary.slice(0, 2000) };
      } else {
        const notAllowed = `Tool "${fnName}" is not available to step sub-agents.`;
        subState.messages.push({ role: "tool", content: notAllowed, tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolResult: notAllowed };
      }
    }
  }

  // Max iterations reached
  yield {
    type: "text", text: `Sub-agent reached max iterations (${maxIter}).`,
    stepComplete: { success: false, summary: `Reached max iterations (${maxIter}).`, iterations: maxIter },
  } as StepSubAgentSseEvent;
}

// ── Main Step-by-Step Agent Loop ──
// Phase 1: Planning → agent creates todo list (write_todos only)
// Phase 2: Lock   → IDE captures and locks the todo list
// Phase 3: Execute→ For each pending todo, spawn a focused sub-agent
// Phase 4: Done   → Summarize all results

export async function* agentLoopStepByStep(
  projectRoot: string,
  state: AgentState,
  context: string,
  sessionId: string,
  modelOpts?: { model?: string; apiKey?: string },
): AsyncGenerator<AgentSseEvent> {
  const apiKey = modelOpts?.apiKey;
  if (!apiKey) {
    yield { type: "error", error: "No server API key configured. Set DEEPSEEK_API_KEY on the server." };
    return;
  }

  const MAX_PLANNING_ITERS = 5;
  const MODEL_CONTEXT_LIMIT = 128_000;

  const makeUsage = (turns: number) => ({
    estimatedTokens: 0,
    contextLimit: MODEL_CONTEXT_LIMIT,
    turns,
    requestCount: state.apiUsageTotals?.requestCount || 0,
    promptTokens: state.apiUsageTotals?.promptTokens || 0,
    completionTokens: state.apiUsageTotals?.completionTokens || 0,
    totalTokens: state.apiUsageTotals?.totalTokens || 0,
    promptCacheHitTokens: state.apiUsageTotals?.promptCacheHitTokens || 0,
    promptCacheMissTokens: state.apiUsageTotals?.promptCacheMissTokens || 0,
  });

  // ── Helper: attach reasoning_content ──
  const rc = (reasoning: string | null | undefined) =>
    reasoning ? { reasoning_content: reasoning } : {};

  // ═══════════════════════════════════════════════════════════════
  //  PHASE 1: PLANNING
  //  The agent has ONLY write_todos. It must create a plan.
  // ═══════════════════════════════════════════════════════════════

  yield { type: "text", text: "Planning phase — breaking down the task into steps...\n" };

  for (let iter = 0; iter < MAX_PLANNING_ITERS; iter++) {
    state.iteration++;
    const openaiMessages: ModelMessage[] = [
      { role: "system", content: PLANNING_SYSTEM_PROMPT },
      ...state.messages.map((m): ModelMessage => {
        if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
        if (m.role === "assistant" && m.name) {
          try {
            const calls = JSON.parse(m.content);
            return { role: "assistant", content: null, tool_calls: calls, ...rc(m.reasoning_content) };
          } catch {
            return { role: "assistant", content: m.content };
          }
        }
        return { role: m.role as "user" | "assistant", content: m.content };
      }),
    ];

    const stream = chatDeepSeekToolStream(openaiMessages, PLAN_ONLY_TOOLS, { model: modelOpts?.model, apiKey });
    let finalText: string | null = null;
    let finalReasoning: string | null = null;
    let finalToolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | null = null;
    let finalApiUsage: DeepSeekApiUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.type === "thinking") {
        yield { type: "thinking", text: chunk.text };
      } else if (chunk.type === "text") {
        yield { type: "text", text: chunk.text };
      } else if (chunk.type === "done") {
        finalText = chunk.finalText ?? null;
        finalReasoning = chunk.reasoningContent ?? null;
        finalToolCalls = chunk.toolCalls ?? null;
        finalApiUsage = chunk.usage;
      }
    }
    addApiUsage(state, finalApiUsage);

    if (!finalToolCalls || finalToolCalls.length === 0) {
      // Agent didn't call any tool — push the text response and inject a reminder
      const reply = finalText || "I'll create a plan.";
      state.messages.push({ role: "assistant", content: reply, ...rc(finalReasoning) });
      state.messages.push({ role: "user", content: "Please call write_todos to create a step-by-step plan for the task. You MUST use write_todos as your next action." });
      yield { type: "text", text: reply };
      continue;
    }

    // Process the tool call (should be write_todos)
    for (const tc of finalToolCalls) {
      const fnName = tc.function.name;
      const params = (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })();

      if (fnName === "write_todos") {
        const todos = params.todos;
        if (!Array.isArray(todos) || todos.length === 0) {
          state.messages.push({
            role: "assistant",
            content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
            name: fnName,
            ...rc(finalReasoning),
          });
          state.messages.push({ role: "tool", content: "Error: todos must be a non-empty array.", tool_call_id: tc.id });
          state.messages.push({ role: "user", content: "Your todo list was empty. Please create a plan with at least 1 step using write_todos." });
          yield { type: "tool_end", toolName: fnName, toolResult: "Error: todos must be a non-empty array." };
          break;
        }

        // Lock the todos
        const lockedTodos: LockedTodo[] = (todos as any[]).map((t: any) => ({
          id: String(t.id || ""),
          text: String(t.text || ""),
          status: "pending" as const,
          agentType: "code-writer",
        }));

        state.lockedTodos = lockedTodos;
        state.messages.push({
          role: "assistant",
          content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
          name: fnName,
          ...rc(finalReasoning),
        });
        state.messages.push({ role: "tool", content: `Plan created with ${lockedTodos.length} steps.`, tool_call_id: tc.id });

        // PHASE 2: LOCK — Emit the locked plan to the client
        yield {
          type: "step_plan",
          lockedTodos: [...lockedTodos],
          toolResult: `Plan locked: ${lockedTodos.length} steps.`,
        };

        // ═══════════════════════════════════════════════════════
        //  PHASE 3: EXECUTE EACH STEP
        //  For each pending todo, spawn a focused sub-agent.
        // ═══════════════════════════════════════════════════════

        const allResults: { text: string; status: string; result: string }[] = [];

        for (let stepIdx = 0; stepIdx < lockedTodos.length; stepIdx++) {
          const todo = lockedTodos[stepIdx];
          todo.status = "in_progress";
          state.currentStepIndex = stepIdx;

          // Build the step context: user request + this step + previous results
          const prevResults = allResults.length > 0
            ? `\n\n### What's been done so far (previous steps):\n${allResults.map((r, i) => `Step ${i + 1}: ${r.text} → ${r.status === "completed" ? "COMPLETED" : "FAILED"}\n  Result: ${r.result.slice(0, 500)}`).join("\n\n")}`
            : "";

          const stepTask = `## Overall Task\n${context}\n\n## Current Step (${stepIdx + 1}/${lockedTodos.length})\n${todo.text}${prevResults}\n\n### Instructions\nFocus ONLY on this step. Read relevant files, make the necessary changes, run verification commands if applicable, then return a concise plain-text report of what you did and the result. Do NOT call task_complete or write_summary.`;

          yield {
            type: "step_begin",
            stepTodo: { ...todo },
            toolResult: `Starting step ${stepIdx + 1}/${lockedTodos.length}: ${todo.text}`,
          };

          const stepConfig = SUB_AGENT_PROFILES[todo.agentType || "code-writer"] || SUB_AGENT_PROFILES["code-writer"];
          let stepSuccess = false;
          let stepSummary = "";
          let stepIterations = 0;

          try {
            // Run the step sub-agent with streaming
            for await (const stepEvent of runStepSubAgent(state, stepTask, stepConfig, { model: modelOpts?.model, apiKey })) {
              // Forward tool_start, tool_end, text, thinking events to the client.
              // Tag tool events with agent marker for color coding.
              const stepAgentType = todo.agentType || "code-writer";
              if (stepEvent.type === "tool_start" || stepEvent.type === "tool_end") {
                yield { ...stepEvent, isSubAgent: true, agentMarker: stepAgentType } as AgentSseEvent;
              } else if (stepEvent.type === "thinking" || stepEvent.type === "text") {
                yield stepEvent;
              }
              if (stepEvent.stepComplete) {
                stepSuccess = stepEvent.stepComplete.success;
                stepSummary = stepEvent.stepComplete.summary;
                stepIterations = stepEvent.stepComplete.iterations;
              }
            }
          } catch (err) {
            stepSummary = `Step error: ${err instanceof Error ? err.message : String(err)}`;
            stepSuccess = false;
          }

          todo.status = stepSuccess ? "completed" : "failed";
          todo.result = stepSummary;
          allResults.push({ text: todo.text, status: todo.status, result: stepSummary });

          yield {
            type: "step_end",
            stepTodo: { ...todo },
            toolResult: `Step ${stepIdx + 1}/${lockedTodos.length} ${stepSuccess ? "completed" : "failed"}: ${stepSummary.slice(0, 500)}`,
          };
        }

        // ═══════════════════════════════════════════════════════
        //  PHASE 4: WRAP-UP — Summarize all results
        // ═══════════════════════════════════════════════════════
        const completedCount = allResults.filter((r) => r.status === "completed").length;
        const failedCount = allResults.filter((r) => r.status === "failed").length;
        const summaryLines = [
          `All ${lockedTodos.length} steps executed.`,
          `${completedCount} completed, ${failedCount} failed.`,
          "",
          ...allResults.map((r, i) => `Step ${i + 1} [${r.status.toUpperCase()}]: ${r.text}\n  ${r.result.slice(0, 300)}`),
        ];

        yield {
          type: "done",
          reply: summaryLines.join("\n"),
          allStepResults: allResults,
          lockedTodos: lockedTodos.map((t) => ({ ...t })),
          usage: makeUsage(state.iteration),
        };
        return;
      }

      // Any other tool call in planning phase
      state.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]),
        name: fnName,
        ...rc(finalReasoning),
      });
      state.messages.push({ role: "tool", content: `Tool "${fnName}" is not available during the planning phase. Only write_todos is allowed.`, tool_call_id: tc.id });
      state.messages.push({ role: "user", content: "During the planning phase, you can ONLY use write_todos. Please call write_todos to create your step-by-step plan." });
      yield { type: "tool_end", toolName: fnName, toolResult: `Not available in planning phase. Use write_todos.` };
    }
  }

  // Planning phase max iterations — force a best-effort plan
  yield { type: "error", error: "Planning phase reached maximum iterations without creating a valid plan." };
  yield { type: "done", reply: "Could not create a plan.", usage: makeUsage(state.iteration) };
}

export async function agentLoop(
  projectRoot: string,
  state: AgentState,
  context: string,
  modelOpts?: { model?: string; apiKey?: string },
): Promise<AgentResponse> {
  const apiKey = modelOpts?.apiKey;
  if (!apiKey) {
    return { phase: "done", reply: "No server API key configured. Set DEEPSEEK_API_KEY on the server." };
  }
  state.iteration++;

  if (state.iteration > MAX_ITERATIONS) {
    const summary = "I've reached the maximum number of steps. " + 
      "Here's a summary of what I've done so far based on the previous tool results.";
    state.messages.push({ role: "assistant", content: summary });
    return { phase: "done", reply: summary, messages: state.messages };
  }

  const rc2 = (reasoning: string | null | undefined) =>
    reasoning ? { reasoning_content: reasoning } : {};

  // Dynamic instruction retrieval — only include relevant prompt chunks
  const openaiMessages = buildOpenAiMessages(state, context);

  const { text, toolCalls, reasoningContent } = await chatDeepSeekTool(openaiMessages, TOOLS, { model: modelOpts?.model, apiKey });

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
        // Track latest todos for pending-task detection at task_complete
        if (fnName === "write_todos" && Array.isArray(params.todos)) {
          state.latestTodos = (params.todos as any[]).map((t: any) => ({
            id: String(t.id || ""), text: String(t.text || ""), status: String(t.status || "pending"),
          }));
        }
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

      // ── Memory tools: remember, recall, forget ──
      if (fnName === "remember" || fnName === "recall" || fnName === "forget") {
        const memResult = await runMemoryTool(fnName, params, projectRoot, apiKey);
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: memResult, tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: memResult.slice(0, 1000) });
        continue;
      }

      // write_summary — validate and store the final summary (required before task_complete)
      if (fnName === "write_summary") {
        const summary = String(params.summary || "");
        if (state.latestTodos && state.latestTodos.length > 0) {
          const hasTodoProgress = /###\s*Todo\s*Progress/i.test(summary);
          if (!hasTodoProgress) {
            const todoItems = state.latestTodos
              .map((t: { id: string; text: string; status: string }) => `  ${t.id}: [${t.status}] ${t.text}`)
              .join("\n");
            const rejectMsg = `Your write_summary summary must include a "### Todo Progress" section listing each todo item's final status. Your current todos:\n${todoItems}\n\nCall write_summary again with the full template including ### Todo Progress.`;
            state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
            state.messages.push({ role: "tool", content: rejectMsg, tool_call_id: tc.id });
            state.messages.push({ role: "user", content: rejectMsg });
            continue;
          }
        }
        const validationError = isVagueSummary(summary);
        if (validationError) {
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
          state.messages.push({ role: "tool", content: validationError, tool_call_id: tc.id });
          state.messages.push({ role: "user", content: `Your write_summary summary was rejected: ${validationError}\nPlease call write_summary again with a proper structured summary.` });
          continue;
        }
        state.latestSummary = summary;
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: "OK", tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: "OK" });
        continue;
      }

      // task_complete — reject if pending todos exist; also requires write_summary first
      if (fnName === "task_complete") {
        const pending = getPendingTodos(state);
        if (pending) {
          const pendingList = pending.map((t) => `  [${t.status}] ${t.text}`).join("\n");
          const rejectMsg = `Cannot complete: ${pending.length} task${pending.length > 1 ? "s" : ""} still pending or in progress:\n${pendingList}\n\nComplete or cancel these tasks with write_todos first, then call task_complete.`;
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
          state.messages.push({ role: "tool", content: rejectMsg, tool_call_id: tc.id });
          state.messages.push({ role: "user", content: `Your task_complete was rejected because you still have pending tasks. Call write_todos to update them (mark as completed or cancelled), then call task_complete again.` });
          continue;
        }
        if (!state.latestSummary) {
          const rejectMsg = `Cannot complete: missing summary. Call write_summary first (with the structured template), then call task_complete.`;
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
          state.messages.push({ role: "tool", content: rejectMsg, tool_call_id: tc.id });
          state.messages.push({ role: "user", content: rejectMsg });
          continue;
        }
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: "OK", tool_call_id: tc.id });
        return { phase: "done", reply: state.latestSummary, messages: state.messages, executedTools };
      }

      // kill_terminal: kill agent-spawned terminal sessions
      if (fnName === "kill_terminal") {
        const sessions = state.agentTerminalSessions || [];
        const requestedIndex = params.index != null ? Number(params.index) : undefined;
        let resultMsg: string;

        if (requestedIndex !== undefined) {
          if (requestedIndex >= 0 && requestedIndex < sessions.length) {
            const s = sessions[requestedIndex];
            killSession(s.groupKey, s.sessionId);
            sessions.splice(requestedIndex, 1);
            resultMsg = `Killed terminal [${requestedIndex}]: ${s.command.slice(0, 80)}`;
          } else {
            resultMsg = `No agent terminal at index ${requestedIndex}. Only ${sessions.length} agent-spawned terminal${sessions.length !== 1 ? "s" : ""} exist (indices 0–${Math.max(0, sessions.length - 1)}). Use kill_terminal without an index to kill all.`;
          }
        } else {
          let killed = 0;
          for (const s of sessions) {
            killSession(s.groupKey, s.sessionId);
            killed++;
          }
          sessions.length = 0;
          resultMsg = killed > 0
            ? `Killed ${killed} terminal session${killed > 1 ? "s" : ""}.`
            : "No active agent terminal sessions to kill.";
        }

        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: resultMsg, tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: resultMsg });
        continue;
      }

      // ── Sub-agent delegation ──
      if (fnName === "delegate_task") {
        const agentType = String(params.agent_type || "code-search");
        const cfg = SUB_AGENT_PROFILES[agentType] || SUB_AGENT_PROFILES["code-search"];
        const subResult = await runSubAgent(state, String(params.task || ""), cfg, { model: modelOpts?.model, apiKey: apiKey! }, agentType);
        if (subResult.phase === "browser_tool") {
          state.pendingSubAgent = {
            subState: subResult.subState,
            config: cfg,
            task: String(params.task || ""),
            agentType,
            parentToolCallId: tc.id,
            parentToolArgs: tc.function.arguments,
            parentReasoning: reasoningContent ?? undefined,
          };
          browserTool = { name: subResult.toolName, id: subResult.toolCallId, params: subResult.params };
          browserBreakIdx = i;
          break;
        }
        const resultText = `[${cfg.name}] Completed in ${subResult.iterations} turns.\n${subResult.summary}`;
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc2(reasoningContent) });
        state.messages.push({ role: "tool", content: resultText, tool_call_id: tc.id });
        executedTools.push({ name: fnName, result: resultText.slice(0, 1000) });
        // Store task + summary in shared prefix for cache benefits on
        // subsequent delegations of the same agent type.
        // Only stores the last 2 pairs (4 messages) — no file content,
        // so stale context from project changes is not a concern.
        if (agentType) {
          if (!state.subAgentPrefix) state.subAgentPrefix = {};
          const taskMsg: AgentMessage = { role: "user", content: String(params.task || "").slice(0, 500) };
          const summaryMsg: AgentMessage = { role: "assistant", content: resultText.slice(0, 1000) };
          state.subAgentPrefix[agentType] = [
            ...(state.subAgentPrefix[agentType] || []).slice(-4),
            taskMsg,
            summaryMsg,
          ];
        }
        continue;
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
    return agentLoop(projectRoot, state, "", modelOpts);
  }

  // No tool calls — final text reply.
  if (text) {
    state.messages.push({ role: "assistant", content: text, ...rc2(reasoningContent) });
  }
  if (hasToolActivity(state) || (state.latestTodos && state.latestTodos.length > 0)) {
    state.messages.push({ role: "user", content: buildTaskCompleteReminder(state, "agent") });
    return agentLoop(projectRoot, state, "", modelOpts);
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
    yield { type: "error", error: "No server API key configured. Set DEEPSEEK_API_KEY on the server." };
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
  // Track how many iterations since last write_todos call — used to inject reminders
  let turnsSinceTodoUpdate = 0;

  // ── Inject pending todos from previous turn ──
  const pendingTodos = state.latestTodos?.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  if (pendingTodos && pendingTodos.length > 0) {
    const pendingList = pendingTodos.map((t) => `  [${t.status}] ${t.text}`).join("\n");
    state.messages.splice(1, 0, {
      role: "assistant" as const,
      content: `⚠️ You have ${pendingTodos.length} pending task${pendingTodos.length > 1 ? "s" : ""} from your previous session:\n${pendingList}\n\nUse write_todos to continue tracking these.`,
    });
  }

  const modelContextLimit = 1_000_000; // All DeepSeek models support 1M context

  const makeUsage = (turns: number) => ({
    estimatedTokens: finalEstTokens,
    contextLimit: modelContextLimit,
    turns,
    requestCount: state.apiUsageTotals?.requestCount || 0,
    promptTokens: state.apiUsageTotals?.promptTokens || 0,
    completionTokens: state.apiUsageTotals?.completionTokens || 0,
    totalTokens: state.apiUsageTotals?.totalTokens || 0,
    promptCacheHitTokens: state.apiUsageTotals?.promptCacheHitTokens || 0,
    promptCacheMissTokens: state.apiUsageTotals?.promptCacheMissTokens || 0,
  });

  // ── Helper: attach reasoning_content if this is a reasoning model ──
  const rc = (reasoning: string | null | undefined) =>
    reasoning ? { reasoning_content: reasoning } : {};

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    state.iteration++;
    turnsSinceTodoUpdate++;
    const openaiMessages = buildMessages();

    // ── Heuristic warnings ──
    // Estimate token count: ~4 chars per token for English text.
    // Include the system prompt (built fresh each turn) which isn't in state.messages.
    const sysLen = openaiMessages[0]?.content?.length || 0;
    const estTokens = estimateStateTokens(state, sysLen);
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
    let finalApiUsage: DeepSeekApiUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.type === "thinking") {
        yield { type: "thinking", text: chunk.text };
      } else if (chunk.type === "text") {
        yield { type: "text", text: chunk.text };
      } else if (chunk.type === "done") {
        finalText = chunk.finalText ?? null;
        finalReasoning = chunk.reasoningContent ?? null;
        finalToolCalls = chunk.toolCalls ?? null;
        finalApiUsage = chunk.usage;
        streamDone = true;
      }
    }
    addApiUsage(state, finalApiUsage);

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
      if (hasToolActivity(state) || (state.latestTodos && state.latestTodos.length > 0)) {
        state.messages.push({ role: "user", content: buildTaskCompleteReminder(state, "agent") });
        continue;
      }
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

      // kill_terminal: kill agent-spawned terminal sessions
      if (fnName === "kill_terminal") {
        yield { type: "tool_start", toolName: fnName, toolParams: params };
        const sessions = state.agentTerminalSessions || [];
        const requestedIndex = params.index != null ? Number(params.index) : undefined;
        let resultMsg: string;
        let killed = 0;

        if (requestedIndex !== undefined) {
          if (requestedIndex >= 0 && requestedIndex < sessions.length) {
            const s = sessions[requestedIndex];
            killSession(s.groupKey, s.sessionId);
            sessions.splice(requestedIndex, 1);
            killed = 1;
            resultMsg = `Killed terminal [${requestedIndex}]: ${s.command.slice(0, 80)}`;
          } else {
            resultMsg = `No agent terminal at index ${requestedIndex}. Only ${sessions.length} agent-spawned terminal${sessions.length !== 1 ? "s" : ""} exist (indices 0–${Math.max(0, sessions.length - 1)}). Use kill_terminal without an index to kill all.`;
          }
        } else {
          // Kill all
          for (const s of sessions) {
            killSession(s.groupKey, s.sessionId);
            killed++;
          }
          sessions.length = 0;
          resultMsg = killed > 0
            ? `Killed ${killed} terminal session${killed > 1 ? "s" : ""}.`
            : "No active agent terminal sessions to kill.";
        }

        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: resultMsg, tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: resultMsg,
          executedTools: [{ name: fnName, result: resultMsg }],
        };
        executedTools.push({ name: fnName, result: resultMsg });
        continue;
      }

      // run_in_terminal: requires user permission (opens real terminal tab)
      if (fnName === "run_in_terminal") {
        let cmd = String(params.command || "");
        // Sanitize bash-isms that break in PowerShell on Windows
        if (process.platform === "win32") {
          // Strip 2>&1 — PowerShell captures stderr by default, and this syntax fails
          cmd = cmd.replace(/\s*2>\s*&1\s*/g, " ");
          // Convert && (bash "and") to ; (PowerShell separator)
          cmd = cmd.replace(/\s*&&\s*/g, "; ");
          cmd = cmd.trim();
        }
        // Update params so the client receives the sanitized command in tool_start
        (params as Record<string, unknown>).command = cmd;
        // Push individual assistant+tool messages for each tool call.
        // run_in_terminal pauses for permission — push "NOT_EXECUTED: This tool was not run because it was batched with other browser tools. Do NOT interpret this as a real result. Call this tool BY ITSELF (not batched with browser_click, browser_type, browser_navigate, browser_screenshot, browser_get_dom, browser_select, or any other browser_* tool) on your next turn to get the actual result." for all
        // other tools so they don't block. The actual run_in_terminal result
        // will be pushed by /stream/continue.
        for (let i = 0; i < finalToolCalls.length; i++) {
          const t = finalToolCalls[i];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: t.function.name, ...rc(finalReasoning) });
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

      // ── File tools: auto-execute, yield diff for Accept/Reject in UI ──
      const FILE_TOOLS = ["edit_file"];
      if (FILE_TOOLS.includes(fnName)) {
        const fp = String(params.path || params.oldPath || "");
        // Push all tool calls as assistant messages; only this one gets executed
        for (let j = 0; j < finalToolCalls.length; j++) {
          const t = finalToolCalls[j];
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }]), name: t.function.name, ...rc(finalReasoning) });
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

      // ── Memory tools: remember, recall, forget ──
      if (fnName === "remember" || fnName === "recall" || fnName === "forget") {
        yield { type: "tool_start", toolName: fnName, toolParams: params };
        const memResult = await runMemoryTool(fnName, params, projectRoot, apiKey);
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: memResult, tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolResult: memResult.slice(0, 2000),
          executedTools: [{ name: fnName, result: memResult.slice(0, 500) }],
        };
        executedTools.push({ name: fnName, result: memResult.slice(0, 1000) });
        continue;
      }

      // ── Read-only + auto-execute filesystem tools (no Accept/Reject prompt) ──
      const isFsTool = [
        "read_file", "list_files", "search_files", "grep", "create_directory", "write_todos", "read_command_output",
        "write_file", "delete_file", "rename_file", "read_graph",
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
            toolParams: params,
            executedTools: [{ name: fnName, result: storedResult.slice(0, 500) }],
          };
          executedTools.push({ name: fnName, result: storedResult.slice(0, 1000) });
          if (fnName === "write_todos") {
             turnsSinceTodoUpdate = 0;
             if (Array.isArray(params.todos)) {
               state.latestTodos = (params.todos as any[]).map((t: any) => ({
                 id: String(t.id || ""), text: String(t.text || ""), status: String(t.status || "pending"),
               }));
             }
           }
        }
        continue;
      }

      // write_summary — validate and store the final summary (required before task_complete)
      if (fnName === "write_summary") {
        yield { type: "tool_start", toolName: fnName, toolParams: params, toolCallId: tc.id };
        const summary = String(params.summary || "");
        if (state.latestTodos && state.latestTodos.length > 0) {
          const hasTodoProgress = /###\s*Todo\s*Progress/i.test(summary);
          if (!hasTodoProgress) {
            const todoItems = state.latestTodos.map((t: { id: string; text: string; status: string }) => `  ${t.id}: [${t.status}] ${t.text}`).join("\n");
            const rejectMsg = `Your write_summary summary must include a "### Todo Progress" section listing each todo item's final status. Your current todos:\n${todoItems}\n\nCall write_summary again with the full template including ### Todo Progress.`;
            state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
            state.messages.push({ role: "tool", content: rejectMsg, tool_call_id: tc.id });
            state.messages.push({ role: "user", content: rejectMsg });
            yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: rejectMsg };
            continue;
          }
        }
        const validationError = isVagueSummary(summary);
        if (validationError) {
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          state.messages.push({ role: "tool", content: validationError, tool_call_id: tc.id });
          state.messages.push({ role: "user", content: `Your write_summary summary was rejected: ${validationError}\nPlease call write_summary again with a proper structured summary.` });
          yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: validationError };
          continue;
        }
        state.latestSummary = summary;
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: "OK", tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolCallId: tc.id,
          toolResult: summary.slice(0, 2000),
          executedTools: [{ name: fnName, result: "OK" }],
        };
        executedTools.push({ name: fnName, result: "OK" });
        continue;
      }

      // task_complete — reject if pending todos exist; also requires write_summary first
      if (fnName === "task_complete") {
        yield { type: "tool_start", toolName: fnName, toolParams: params, toolCallId: tc.id };
        const pending = getPendingTodos(state);
        if (pending) {
          const pendingList = pending.map((t) => `  [${t.status}] ${t.text}`).join("\n");
          const rejectMsg = `Cannot complete: ${pending.length} task${pending.length > 1 ? "s" : ""} still pending or in progress:\n${pendingList}\n\nComplete or cancel these tasks with write_todos first, then call task_complete.`;
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          state.messages.push({ role: "tool", content: rejectMsg, tool_call_id: tc.id });
          state.messages.push({ role: "user", content: `Your task_complete was rejected because you still have pending tasks. Call write_todos to update them (mark as completed or cancelled), then call task_complete again.` });
          yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: rejectMsg };
          continue;
        }
        if (!state.latestSummary) {
          const rejectMsg = `Cannot complete: missing summary. Call write_summary first (with the structured template), then call task_complete.`;
          state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
          state.messages.push({ role: "tool", content: rejectMsg, tool_call_id: tc.id });
          state.messages.push({ role: "user", content: rejectMsg });
          yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: rejectMsg };
          continue;
        }
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: "OK", tool_call_id: tc.id });
        yield { type: "tool_end", toolName: fnName, toolCallId: tc.id, toolResult: "OK" };
        yield { type: "done", reply: state.latestSummary, usage: makeUsage(iter + 1) };
        return;
      }

      // ── Sub-agent delegation (streaming — live tool cards) ──
      if (fnName === "delegate_task") {
        const agentType = String(params.agent_type || "code-search");
        const cfg = SUB_AGENT_PROFILES[agentType] || SUB_AGENT_PROFILES["code-search"];
        yield { type: "tool_start", toolName: fnName, toolParams: params, toolCallId: tc.id, agentMarker: agentType };
        
        // Run sub-agent with live streaming — each tool call yields a tool_start/tool_end
        const streamResult = runSubAgentStream(state, String(params.task || ""), cfg, agentType, { model: modelOpts?.model, apiKey: apiKey! });
        
        let subResult: SubAgentResult;
        // Forward all sub-agent events to the frontend
        while (true) {
          const { value, done } = await streamResult.next();
          if (done) {
            subResult = value as SubAgentResult;
            break;
          }
          // Forward sub-agent tool events — agentMarker is already set.
          // Skip text events from sub-agents to avoid polluting the parent's message flow.
          if (value.type === "tool_start" || value.type === "tool_end") {
            yield value;
          } else if (value.type === "browser_tool") {
            // browser_tool from sub-agent: treat same as parent browser_tool
            yield value;
          }
        }
        
        if (subResult!.phase === "browser_tool") {
          state.pendingSubAgent = {
            subState: subResult!.subState,
            config: cfg,
            task: String(params.task || ""),
            agentType,
            parentToolCallId: tc.id,
            parentToolArgs: tc.function.arguments,
            parentReasoning: finalReasoning ?? undefined,
          };
          yield {
            type: "browser_tool",
            toolName: subResult!.toolName,
            toolParams: subResult!.params,
            toolCallId: subResult!.toolCallId,
            sessionId,
            executedTools,
            subAgentParentToolCallId: tc.id,
            agentMarker: agentType,
          };
          return;
        }
        const resultText = `[${cfg.name}] Completed in ${subResult!.iterations} turns.\n${subResult!.summary}`;
        state.messages.push({ role: "assistant", content: JSON.stringify([{ id: tc.id, type: "function", function: { name: fnName, arguments: tc.function.arguments } }]), name: fnName, ...rc(finalReasoning) });
        state.messages.push({ role: "tool", content: resultText, tool_call_id: tc.id });
        yield {
          type: "tool_end",
          toolName: fnName,
          toolCallId: tc.id,
          toolResult: resultText.slice(0, 2000),
          agentMarker: agentType,
          executedTools: [{ name: fnName, result: resultText.slice(0, 500) }],
          subAgentName: cfg.name,
          subAgentMessages: subResult!.subState.messages.map((m: AgentMessage) => ({
            role: m.role,
            content: m.content || "",
            name: m.name,
            reasoning_content: m.reasoning_content,
          })),
        };
        executedTools.push({ name: fnName, result: resultText.slice(0, 1000) });
        // Store task + summary in shared prefix for cache benefits on
        // subsequent delegations of the same agent type (streaming path).
        if (agentType) {
          if (!state.subAgentPrefix) state.subAgentPrefix = {};
          const taskMsgS: AgentMessage = { role: "user", content: String(params.task || "").slice(0, 500) };
          const summaryMsgS: AgentMessage = { role: "assistant", content: resultText.slice(0, 1000) };
          state.subAgentPrefix[agentType] = [
            ...(state.subAgentPrefix[agentType] || []).slice(-4),
            taskMsgS,
            summaryMsgS,
          ];
        }
        continue;
      }

      // Browser tool (streaming path)
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
    // ── Todo drift guard: if agent has gone 3+ turns without updating todos,
    //     inject a reminder to keep the user informed of progress ──
    if (turnsSinceTodoUpdate >= 3 && state.messages.some((m) => m.name === "write_todos")) {
      state.messages.push({ role: "user", content: "⚠️ You have not updated your todo list in several turns. Call write_todos NOW to mark your current item's progress — the user needs to see what you've accomplished." });
      turnsSinceTodoUpdate = 0; // only inject once, don't spam
    }
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

export function storeCommandOutput(command: string, output: string, exitCode?: number | null, timedOut?: boolean): number {
  const seq = ++cmdSeq;
  commandOutputStore.set(seq, {
    command,
    output,
    totalChars: output.length,
    exitCode: exitCode ?? null,
    timedOut: timedOut ?? false,
  });
  if (commandOutputStore.size > 50) {
    const oldest = Math.min(...commandOutputStore.keys());
    commandOutputStore.delete(oldest);
  }
  return seq;
}

export function clearCommandOutputs() {
  cmdSeq = 0;
  commandOutputStore.clear();
}

// ── Session management ──

const agentSessions = new Map<string, AgentState>();

export function createAgentSession(sessionId: string, projectRoot: string, userMessage: string, context: string): AgentState {
  const prev = agentSessions.get(sessionId);
  if (prev) {
    prev.projectRoot = projectRoot;
    prev.iteration = 0;
    prev.latestSummary = undefined;
    prev.pendingSubAgent = undefined;
    prev.apiUsageTotals = undefined;
    prev.messages.push({ role: "user", content: userMessage });
    agentSessions.set(sessionId, prev);
    return prev;
  }

  const state: AgentState = {
    messages: [{ role: "user", content: userMessage }],
    iteration: 0,
    projectRoot,
    apiUsageTotals: undefined,
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
