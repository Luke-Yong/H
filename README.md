# Harness

AI-powered coding agent using Monaco Editor and DeepSeek.

## Setup

```powershell
# Install dependencies
npm run install:all
```

## Configuration

Copy `.env.example` to `.env` and add your DeepSeek API key:

```powershell
copy .env.example .env
```

```
# .env
DEEPSEEK_API_KEY=sk-your-key-here
```

Get a key at [platform.deepseek.com](https://platform.deepseek.com).

## Start

```powershell
npm run dev
```

This starts both the backend (port 3001) and frontend (port 5173). Open `http://localhost:5173`.

## Architecture

Harness is a client-server application with an optional Electron desktop shell.

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Shell (desktop mode)                              │
│  ┌──────────────────────────┐  ┌──────────────────────────┐ │
│  │  Client (React + Vite)   │  │  Server (Express + WS)   │ │
│  │                          │  │                          │ │
│  │  Monaco Editor           │  │  Agent loop (tool-call)  │ │
│  │  xterm.js terminals      │  │  LSP stdio bridge        │ │
│  │  Agent console (SSE)     │  │  Terminal manager (PTY)  │ │
│  │  File tree / SCM panel   │  │  Browser reverse proxy   │ │
│  │  Browser webview         │  │  Git / FS / System APIs  │ │
│  └──────────┬───────────────┘  └────────────┬─────────────┘ │
│             │  HTTP + SSE + WebSocket       │               │
│             └───────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  DeepSeek   │
                    │  API (HTTPS)│
                    └─────────────┘
```

### Server (`server/`)

The Node.js Express server on **port 3001** is the backbone. It owns all backend logic and never runs in the browser.

| Layer | File | Role |
|---|---|---|
| HTTP API | `server/index.ts` | REST endpoints for filesystem CRUD, git status/commit/diff, project detection, system stats, and agent chat (blocking + SSE streaming + step-by-step) |
| Agent loop | `server/agent.ts` | Tool-calling orchestration: receives user messages, sends tool definitions to DeepSeek, executes filesystem/terminal tools, manages browser tool handoff, compacts conversation history |
| DeepSeek bridge | `server/deepseek.ts` | Raw DeepSeek API calls — chat, tool-calling, and SSE streaming — with prefix-cache tracking |
| LSP bridge | `server/lsp.ts` | Spawns language servers over stdio, forwards diagnostics to the client, handles completions and hover |
| Terminal manager | `server/terminalManager.ts` | Creates per-session shell processes (PTY via `node-pty` or pipe fallback), routes I/O between client WebSocket messages and child process stdio, auto-detects localhost URLs in terminal output |
| Browser proxy | `server/index.ts` (`/_browser`) | Reverse-proxies external URLs through the server so the client iframe stays same-origin, strips `X-Frame-Options` headers, injects a restrictive CSP |

**3 transport channels to the client:**

- **HTTP** — Standard REST for file reads/writes, git operations, LSP diagnostics, agent chat init
- **SSE (Server-Sent Events)** — One-way streaming for agent thinking/text/tool events during an agent turn
- **WebSocket** — Bidirectional for terminal I/O (`term:create`, `term:write`, `term:resize`, `term:kill`) and server-to-client broadcasts (logs, errors, browser URL detection)

### Client (`client/`)

The React + Vite frontend runs on **port 5173** in development. In desktop/production mode, the Express server serves the built static files directly from `client/dist/`.

| Pane | File | Role |
|---|---|---|
| Editor | `EditorPane.tsx` | Monaco Editor with tabs, file tree, SCM panel, built-in browser webview, and terminal tabs — the main workspace |
| Agent console | `AgentConsole.tsx` | Chat interface for the AI agent. Sends user goals to `/api/chat/agent/stream`, consumes the SSE event stream, renders tool calls with spinners/results, prompts user for permission on `run_in_terminal`/`browser_eval`, and shows Accept/Reject diffs for file edits |
| Files panel | `FilesPanel.tsx` | File explorer tree with create/rename/delete, right-click context menu, and folder expansion state persistence |
| Terminal | `TerminalPane.tsx` | xterm.js terminal tabs, connected via WebSocket to the server's terminal manager |
| SCM panel | `ScmPanel.tsx` | Git staging area, commit history, diff viewer |
| Status bar | `StatusBar.tsx` | Language selector, encoding, indentation, cursor position, go-to-line |
| Menu bar | `MenuBar.tsx` | File/Edit/View/Terminal/Help menus |

The client **never calls DeepSeek directly**. All AI interaction flows through the server's agent loop, which owns the API key and tool execution.

### Data flow (agent turn)

```
User types goal → AgentConsole
  → POST /api/chat/agent/stream (message, context, projectRoot)
     or POST /api/chat/agent/stream/stepbystep (IDE-driven mode)
  → Server builds dynamic system prompt (ITR), compacts history, calls DeepSeek
  → DeepSeek returns text/tool_calls via SSE stream
  → Server executes filesystem tools (read_file, write_file, etc.) directly
  → Browser tools (browser_click, browser_type, etc.) yield SSE "browser_tool" event
  → AgentConsole sends browser command to EditorPane's webview
  → WebView executes the action, returns result
  → AgentConsole calls POST /api/chat/agent/stream/continue (toolCallId, result)
  → Loop continues until task_complete
```

### Desktop vs web mode

| Feature | Web (browser) | Desktop (Electron) |
|---|---|---|
| Server | External process (`npm run dev:server`) | Embedded via `tsx` require in the Electron main process |
| Client | Vite dev server (port 5173) or served by Express (production) | Vite dev server in dev, served by Express in production |
| Terminal | WebSocket to server, pipe-fallback PTY | WebSocket to server, `node-pty` with ConPTY on Windows |
| File access | Browser File System Access API or server FS APIs | Server FS APIs + native Electron `dialog` for folder/file pickers |
| Built-in browser | iframe + reverse proxy (`/_browser`) | Electron `webview` with geolocation, permissions, popup interception |

## Desktop (Electron)

Harness can also run as a desktop app (closer to VS Code) with an embedded server and a PTY-backed terminal.

```powershell
# Desktop dev (runs Vite + Electron)
npm run desktop:dev
```

```powershell
# Build the client for desktop packaging
npm run desktop:build

# Package a Windows build (electron-builder)
npm run desktop:pack
```

Notes:
- `npm install` runs `electron-rebuild` for `node-pty` automatically (via `postinstall`).
- The terminal prefers `node-pty` (ConPTY on Windows) and falls back to pipe mode if PTY isn't available.

## Built-in Browser (Desktop)

In Electron mode, Harness includes a full browser in the editor area powered by an Electron `webview`.

### Features

**Auto-detect localhost URLs** — When a terminal process starts a local server, the browser detects the URL and opens it as a new tab automatically.

**Manual navigation** — Type a URL or a Bing search query in the address bar and press Enter or click Go.

**Back / Forward / Refresh** — Toolbar buttons with disabled state when navigation isn't available.

**Site information** — Click the security icon to see the connection status (secure/not secure), the current URL, and permission toggles.

**Site permissions** — Per-origin toggles for:
- **Geolocation** — Uses Windows native location via PowerShell `GeoCoordinateWatcher` (no Google API key required). Location is cached IDE-wide and refreshed every 5 minutes. Works across all navigation without re-granting.
- Camera / Microphone / MIDI / Autoplay

**Tabbed browsing** — Multiple browser tabs can be open at the same time, just like file tabs.

**Title syncing** — The browser tab label follows the page's `<title>`.

**Pop-up interception** — Links that would open a new Electron window are captured and opened as a new Harness browser tab instead.

**Cross-navigation location** — `navigator.geolocation` is overridden at `dom-ready` so the page always uses Harness's native Windows location bridge, even after navigating between routes.

> **Note:** Geolocation requires `https://` or `localhost`. The Windows Location API must be enabled in Windows Settings (`Privacy > Location`).

## Language Support (LSP)

Harness provides editor intelligence — continuous error/warning checking, completions, and hover — through two layers:

**1. Built-in (no setup):** Monaco validates these in the browser, live as you type:

- JavaScript / TypeScript (JSX/TSX)
- JSON, CSS / SCSS / LESS, HTML

**2. Language Server (LSP):** For everything else, Harness talks to a standard language server over stdio (`server/lsp.ts`). The architecture follows the VS Code model — push-based, real-time diagnostics via Server-Sent Events (SSE).

### Architecture (VS Code-style push model)

```
┌─ Client (EditorPane.tsx) ─────────────────────────────────────┐
│                                                                │
│  User types in editor                                          │
│       │                                                        │
│       ▼ (250ms debounce)                                       │
│  POST /api/lsp/diagnostics  ─── fire-and-forget didChange     │
│       │                                                        │
│       │                              ┌──────────────────┐     │
│       │   GET /api/lsp/watch ─── SSE │  EventSource per │     │
│       │   (persistent connection)     │  language        │     │
│       │                              └──────┬───────────┘     │
│       │                                     │                  │
│       │    publishDiagnostics event ◄───────┘                 │
│       ▼                                                        │
│  monaco.editor.setModelMarkers() ── squiggles appear          │
└────────────────────────────────────────────────────────────────┘
                               │
┌─ Server (lsp.ts) ────────────▼────────────────────────────────┐
│                                                                │
│  notifyFileChange()                                            │
│       │                                                        │
│       ▼                                                        │
│  sendNotification("textDocument/didChange") ──► LSP process   │
│       │                                            │           │
│       │         textDocument/publishDiagnostics ◄──┘           │
│       ▼                                                        │
│  handleMessage() ── broadcasts to all SSE clients              │
│       │                                                        │
│       ▼                                                        │
│  client.write("data: {uri, markers}\n\n") ──► SSE stream      │
└────────────────────────────────────────────────────────────────┘
```

**Key differences from polling-based approaches:**

| Aspect | Old (polling) | New (VS Code-style) |
|---|---|---|
| Diagnostics delivery | Client polls `/api/lsp/diagnostics` every 250ms | LSP server pushes via SSE — instant |
| Cross-file analysis | Only the changed file was polled | All files receive diagnostics from any change |
| URI handling | Polling used module-level Map with manual key normalization | SSE streams normalized URIs directly to matching file |
| Connection | One HTTP request per file change | One persistent SSE connection per language |

**How it works:**

1. **SSE connection** — When a file is opened, the client establishes a persistent `GET /api/lsp/watch?rootPath=...&language=...` SSE connection per language. The server holds the connection open and registers it in `session.sseClients`.

2. **File change notification** — On content change (250ms debounce), the client fires a `POST /api/lsp/diagnostics` with the file text. The server sends `textDocument/didOpen` or `textDocument/didChange` to the LSP process and returns immediately (fire-and-forget).

3. **Diagnostics push** — When the LSP server emits `textDocument/publishDiagnostics`, `handleMessage()` broadcasts the markers to ALL connected SSE clients for that language. The client receives the event, matches the URI to an open file, and calls `monaco.editor.setModelMarkers()` to render squiggles.

4. **Cross-file analysis** — Because pyright (and other LSP servers) scan the entire workspace on any change, diagnostics for ALL files arrive via SSE and are applied simultaneously. Opening file2 immediately shows errors that pyright published during file1's analysis.

A language server is only used **if its executable is found on your `PATH`**. If it isn't installed, that language is simply skipped — no errors, no setup required.

### URI normalization

Different LSP servers encode file URIs differently — pyright uses `%3A` for drive letters and `%5C` for backslashes, pylsp uses bare characters, some double-encode. The `normalizeUri()` function in `server/lsp.ts` handles all variants:

- Progressive `decodeURIComponent` (handles double-encoding like `%2520`)
- Per-character fallback for mixed raw/encoded URIs
- Backslash → forward slash normalization
- Case-insensitive matching (lowercase)

### Supported languages and their servers

| Language        | Server binary                  | Install (example)                                      |
| --------------- | ------------------------------ | ------------------------------------------------------ |
| Python          | `pyright-langserver` (preferred)<br>`pylsp` (fallback) | `npm i -g pyright`<br>`pip install python-lsp-server pyflakes` |
| JavaScript / TS | *(Monaco built-in)*            | —                                                      |
| HTML / CSS / JSON | *(Monaco built-in)*          | —                                                      |
| Java            | `jdtls`                        | install Eclipse JDT Language Server                    |
| C#              | `omnisharp`                    | install OmniSharp (`-lsp`)                             |
| C / C++         | `clangd`                       | install LLVM/clangd                                    |
| Go              | `gopls`                        | `go install golang.org/x/tools/gopls@latest`          |
| Rust            | `rust-analyzer`                | `rustup component add rust-analyzer`                   |
| Ruby            | `solargraph`                   | `gem install solargraph`                               |
| PHP             | `intelephense`                 | `npm i -g intelephense`                                |
| Swift           | `sourcekit-lsp`                | ships with the Swift toolchain                         |
| Kotlin          | `kotlin-language-server`       | install kotlin-language-server                         |
| Markdown        | `marksman`                     | install marksman                                       |
| YAML            | `yaml-language-server`         | `npm i -g yaml-language-server`                        |
| SQL             | `sqls`                         | `go install github.com/lighttiger2505/sqls@latest`    |

> Additional servers are also mapped out of the box (Lua, Dockerfile, Vue, Svelte, Dart, Elixir, Haskell, Terraform, Clojure, OCaml, Zig, Scala, TOML, Bash) — install the corresponding binary and reload.

After installing a server, **restart the backend** (`npm run dev:server`, or `npm run dev`) so the new executable is detected.

### Reducing false positives

To keep diagnostics signal-heavy, Harness tunes two noisy defaults:

- **JavaScript** runs **syntax-only** validation (semantic/type checks are disabled), since plain browser JS has no type or module information. TypeScript keeps full semantic checking.
- **Python (`pylsp`)** keeps `pyflakes` (real bugs: undefined/unused names, syntax) and disables the style/complexity linters (`pycodestyle`, `pydocstyle`, `mccabe`, `flake8`, `pylint`).

### Adding a language

Add an entry to `SERVER_SPECS` in `server/lsp.ts` mapping the language id to its server binary, and (if needed) the file extension in `detectLanguage` in `client/src/panes/fileModel.ts`.

## File Management

Harness includes a file explorer tree (`FilesPanel`) with full create, delete, and rename capabilities — both for your manual use and for the AI agent.

**Creating files**
- Click the **+** button in the files header to create a new file. If no folder is selected in the tree, the file is created in the project root. If a folder is **selected** (click it once — it highlights), the new file is created inside that folder.
- Folders are automatically created on demand when you add a file under a path that doesn't exist yet.

**Right-click context menu**
- Right-click any item in the file tree to **Rename** or **Delete** it.
- Deleting a folder removes it recursively.

**AI Agent file access**
The AI agent has filesystem tools:

| Tool | Description |
|------|-------------|
| `read_file` | Reads a file with line numbers (or lists a directory) |
| `write_file` | Creates or overwrites a file with full content |
| `edit_file` | Targeted string replacement — send only the lines that change |
| `list_files` | Lists directory contents (skips `.git` / `node_modules`) |
| `search_files` | Recursively find files/folders by name pattern |
| `grep` | Search file contents for a regex pattern |
| `create_directory` | Creates a new directory (and any parent dirs) |
| `rename_file` | Renames or moves a file or directory |
| `delete_file` | Deletes a file or directory (recursively) |

All tools operate relative to the project root. The agent can browse, create, edit, and clean up files on its own — no manual intervention needed.

**Server APIs**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fs/create-file` | POST | Creates a file (and parent dirs) if it doesn't already exist |
| `/api/fs/delete` | DELETE | Deletes a file or directory (recursive for dirs) |
| `/api/fs/rename` | POST | Renames / moves a file or directory |
| `/api/fs/read-binary` | GET | Read a file as binary (used by `browser_upload_file`) |

## Security

Harness gives the AI agent access to your filesystem, terminal, and browser. The following mitigations protect against supply-chain risks (compromised API responses, model prompt injection, or malicious tool outputs).

### API & Transport

- All DeepSeek API calls use **HTTPS** (`https://api.deepseek.com/v1`).
- The API key is never exposed to child processes (see Terminal Sandbox below).

### Tool-Level Guards

| Tool | Guard | Blocks |
|------|-------|--------|
| `browser_navigate` | **URL validation** | `javascript:`, `data:`, `file:` protocols. Only `http://` and `https://` allowed. |
| `browser_eval` | **Pattern block** + **User permission** | `document.cookie`, `fetch()`, `XMLHttpRequest`, `window.open`, `window.location`, `WebSocket`, `import()`, `sendBeacon`. User must Allow each execution. |
| `run_command` | **Env sanitization** | Any env var whose name contains `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, or starts with `npm_` is stripped before the child process starts. Only `PATH`, `HOME`, `USER`, `TEMP`, `SHELL`, `SYSTEMROOT`, `LANG` are forwarded. |
| `run_in_terminal` | **User permission** + **Command sanitization** | User must explicitly Allow each command before it runs. On Windows, bash syntax (`2>&1`, `&&`) is auto-corrected to PowerShell equivalents. |
| `read_file` / `grep` / `list_files` / `write_file` / `edit_file` / `delete_file` / `rename_file` / `search_files` | **Secret-file block** | All filesystem tools refuse access to files matching `.env`, `.env.*`, `credentials.*`, `secret.*`, `.pem`, `.key`, `.p12`, `.pfx`, and `config/*secret*` / `config/*key*` paths. These files are also hidden from directory listings and search results. |

### Browser Sandbox

- The **iframe** is sandboxed with `allow-scripts allow-same-origin allow-forms allow-popups`. Blocked: top-navigation (can't escape the frame), plugins, modals, pointer-lock, downloads.
- A **Content-Security-Policy** header is injected into all proxied pages: `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'self'; form-action *`. This prevents proxied sites from making `fetch()` calls to Harness's own API endpoints.
- The original site's `X-Frame-Options` and `Content-Security-Policy` headers are stripped to allow framing, but the injected CSP replaces them.

### Human-in-the-Loop

| Trigger | Mechanism |
|---------|-----------|
| `run_in_terminal` | Allow/Deny prompt in the agent console |
| `browser_eval` | Allow/Deny prompt with the code previewed |
| `write_file` / `delete_file` | Accept/Reject undo cards in the agent console |

### Limitations

- **DeepSeek's API response is still trusted by design.** If the model provider's infrastructure were compromised and injected malicious tool calls, the tool-level guards (URL validation, eval blocking, env sanitization) would catch the most dangerous classes of attack, but not all. Run Harness in isolated environments (VM, dev container) when working with untrusted projects.
- **`run_command` is not container-sandboxed.** It uses `child_process.spawn` with a cleaned environment. For full isolation, run Harness inside Docker or a VM.
- File writes are undoable via the UI, but the agent has full write access to the project directory.

## Agent Tools (DeepSeek-powered)

The AI agent has access to these tools when working on your project:

### Filesystem

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with line numbers — always read before editing |
| `write_file` | Create or overwrite a file with full content (requires user accept/reject) |
| `edit_file` | Targeted edit by replacing old_string with new_string. Much cheaper — only send the lines that change. old_string must match exactly including whitespace/indentation. Use replace_all to replace all occurrences. |
| `list_files` | List files and directories in a given path |
| `search_files` | Recursively find files/folders by name pattern (case-insensitive) |
| `grep` | Search file contents for a regex pattern — find definitions, usages |
| `create_directory` | Create a directory (and parents) |
| `rename_file` | Rename or move a file or directory |
| `delete_file` | Delete a file or directory recursively |

### Terminal

| Tool | Type | Description |
|------|------|-------------|
| `run_command` | **Sandbox** | Run a shell command with inline output. Fast, no permission needed. Use for: tests, lint, git, pip, npm, builds, grep. Output is summarized to key lines (errors, warnings, URLs); full output is cached for `read_command_output`. |
| `run_in_terminal` | **Real terminal** | Run a long-running command in a dedicated terminal tab. User must Allow each command. Use for: `python app.py`, `npm start`, flask, watch mode, interactive shells. The agent **waits for the command to exit or produce recognizable output** (traceback, server-started message, etc.) before receiving the result. Terminal output is captured in full for the UI tool card, and a summarized version (key error/success lines) is sent to the model to save tokens. |
| `kill_terminal` | **Control** | Kill agent-spawned terminal sessions. **`kill_terminal`** kills all, **`kill_terminal index=N`** kills the Nth terminal (0-based, in order of creation). Only kills terminals the agent started — user-created terminals are untouched. Returns a message confirming which terminal was killed and its command. Use to stop servers, free ports, or clean up before finishing. |

#### `run_in_terminal` lifecycle

```
Agent calls run_in_terminal
  → Command sanitized (Windows: strip 2>&1, && → ;)
  → User Allow/Deny prompt
  → Command runs in terminal tab
  → Agent waits for:
       - Process exit (onFinish)
       - Server started pattern (e.g. "listening on :3000")
       - Error detected (traceback, ModuleNotFoundError, npm ERR!, etc.) → 500ms flush delay
       - 120s timeout fallback
  → Full terminal output sent to UI tool card
  → Summarized output (key lines, 8 lines / 1200 chars max) pushed to model context
  → Full output cached in commandOutputStore for read_command_output with [cmd #N] key
  → Agent reads result and acts on errors or proceeds to browser
```

**Windows/PowerShell compatibility:** On Windows, the terminal runs PowerShell. Bash-isms that would fail silently are auto-corrected:

| Bash syntax | Problem | Auto-fix |
|-------------|---------|----------|
| `2>&1` | PowerShell doesn't understand stderr redirect; causes parse error | Stripped (PowerShell captures stderr natively) |
| `&&` (chain on success) | PowerShell uses `;` for command chaining | Converted to `;` |

**Output handling for long logs:** If the terminal outputs thousands of lines (e.g. verbose app startup), only a summarized view reaches the model — error lines, warnings, and success markers from the full output, limited to 8 lines / 1200 characters. The full output is always available via `read_command_output cmd_id=N` with pagination (`offset`, `limit`) and regex filtering (`filter`).

### Browser

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL (http/https only). Creates a new browser tab if none exists, or navigates the active tab. Waits for the browser view to mount before returning (up to 2s), so subsequent tools like `browser_info` / `browser_screenshot` work immediately. Returns `"Navigating to {url}. Browser ready."` on success. |
| `browser_info` | Get current browser tab state: URL, page title, load status, and open tab count. Use before other browser tools to confirm the page is loaded. |
| `browser_screenshot` | Get a text snapshot of the current page (URL, title, visible text, form fields, buttons, errors) — DeepSeek is text-only, returns readable text not an image |
| `browser_get_dom` | Get indexed clickable/typable elements with pixel coordinates (`(x:NNN y:NNN WWWxHHH)`) and viewport size |
| `browser_click` | Click by DOM index or pixel coordinates (x,y). Dispatches full pointer/mouse event sequence. Index mode auto-computes center from bounding rect. Use before `browser_type`/`browser_clear`/`browser_select` to activate inputs for reactive frameworks |
| `browser_move_mouse` | Move the cursor to x,y — triggers mousemove/pointermove for hover effects without clicking |
| `browser_right_click` | Right-click at x,y — dispatches contextmenu event |
| `browser_type` | Type text into an input by DOM index. Clicks the element first, clears existing value, then types each character with realistic keyboard events (keydown/keypress/input/keyup + change) |
| `browser_clear` | Clear the value of an input element by DOM index — clicks first, then clears and dispatches change |
| `browser_select` | Select an option from a `<select>` dropdown by value or label — clicks the select first, then sets value and dispatches input + change |
| `browser_scroll` | Scroll the page by pixels or to top/bottom — reveals lazy-loaded or off-screen content |
| `browser_press_key` | Press a keyboard key (Enter, Escape, Tab, Arrows, Backspace, etc.) on the active element — submits forms, closes modals, navigates lists |
| `browser_upload_file` | Set files on a file input by absolute paths via `/api/fs/read-binary` |
| `browser_wait` | Wait for an element matching a CSS selector to appear (polls every 200ms, default 5s timeout) |
| `browser_eval` | Run JavaScript in the page (user permission required; dangerous patterns blocked) |
| `browser_console` | Get the last 50 console entries (log, warn, error, dialogs) to check for JS errors |
| `browser_request_errors` | Get failed network requests (4xx/5xx/CORS) to verify API calls and resource loads |

### Diagnostics

| Tool | Description |
|------|-------------|
| `read_problems` | Read current IDE diagnostics — linter errors, TypeScript errors, warnings, hints, debug console, output, browser console. Call after making changes to verify no new errors. |

### Control

| Tool | Description |
|------|-------------|
| `write_todos` | Create or update a structured task list to track progress. In step-by-step mode, this is the ONLY tool available during planning — the agent must create a complete plan before any execution begins. |
| `task_complete` | Signal completion with a **structured summary** using the template: `### Changes Made`, `### Verification`, `### Outcome`. Vague or thought-process-style summaries (e.g. "I did the task") are **rejected** by the server — the agent must rewrite until the summary is concrete. |
| `delegate_task` | Delegate a sub-task to a specialized sub-agent (browser, code-search, code-writer, researcher) that runs independently with its own context window |
| `delegate_parallel` | Delegate multiple sub-tasks to run in parallel, each with its own sub-agent. Returns combined results |

### Multi-Agent Delegation

Harness supports **sub-agent delegation** — the main agent can spawn specialized sub-agents to handle complex sub-tasks in isolation. Each sub-agent gets its own context window, so its conversation history does not bloat the parent agent's context.

#### Architecture

```
┌──────────────────────────────────────────────┐
│  Parent Agent (Orchestrator)                 │
│  - Breaks down user request with write_todos │
│  - Calls delegate_task / delegate_parallel   │
│  - Synthesizes results, calls task_complete  │
└──────┬──────────────┬────────────────────────┘
       │              │
       ▼              ▼
┌──────────────┐  ┌──────────────┐
│ Sub-Agent #1 │  │ Browser Agent│
│ Isolated     │  │ Isolated     │
│ AgentState   │  │ AgentState   │
│ Own context  │  │ browser_*    │──► Paused ──► Renderer executes tool
│ Own tools    │  │ tools only   │◄── Result  ◄── /continue resumes agent
│ Result → sum │  │ Result → sum │
└──────────────┘  └──────────────┘
```

#### Agent Profiles

| Profile | Tools | Iterations | Description |
|---------|-------|-----------|-------------|
| `browser` | `browser_navigate`, `browser_info`, `browser_screenshot`, `browser_get_dom`, `browser_click`, `browser_type`, `browser_clear`, `browser_select`, `browser_press_key`, `browser_console`, `browser_request_errors`, `browser_scroll`, `browser_wait`, `browser_eval` | 15 | Full browser automation. Navigates pages, clicks elements, types text, fills forms, clears inputs, selects dropdowns, presses keys, scrolls, and inspects DOM/console/network. Reports results with element indices and interaction outcomes. |
| `code-search` | `read_file`, `list_files`, `search_files`, `grep` | 8 | Read-only code exploration. Finds files, reads code, reports findings. Never edits. |
| `code-writer` | Full filesystem + `run_command`, `read_problems` | 25 | Implements features or fixes bugs. Reads, edits, builds, and verifies. |
| `researcher` | `read_file`, `list_files`, `search_files`, `grep`, `run_command` | 10 | Explores codebase to answer questions. Reports with file paths and line numbers. |

#### Key Design

| Feature | Detail |
|---------|--------|
| **Context isolation** | Each sub-agent has its own `AgentState` — messages do not pollute the parent's context |
| **Tool allowlisting** | Sub-agents receive only the tools their profile specifies (e.g. code-search can never write files) |
| **Headless execution** | Code-search, code-writer, and researcher sub-agents run entirely server-side — no browser or terminal tools |
| **Browser sub-agent** | Has full browser automation tools: navigate, info, screenshot, get_dom, click, type, clear, select, press_key, scroll, wait, console, eval. Pauses/resumes across browser tool calls via the parent's renderer |
| **Result summarization** | Sub-agent results are compressed before returning to the parent, preserving context budget |
| **Parallelism** | `delegate_parallel` runs multiple sub-agents concurrently via `Promise.all` |

#### Usage

The parent agent uses these tools just like any other:

```
Agent: write_todos todos=[
  {id:1 text:"Research existing auth code" status:pending},
  {id:2 text:"Add login endpoint" status:pending}
]

Agent: delegate_task task="Find all authentication-related code 
  in the project. Report file paths, line numbers, and patterns used."
  agent_type="code-search"

→ [Code Search Agent] Completed in 4 turns.
  Found auth code in:
  - server/auth.ts:45-120 (JWT verification, password hashing)
  - client/src/Login.tsx:1-80 (login form component)
  ...
```

**Browser agent example** — the sub-agent can now navigate, click, type, and inspect pages interactively:

```
Parent: delegate_task task="Go to http://localhost:3000/login,
  type 'admin' into the email field, type 'pass123' into the
  password field, click Sign In, and report what happens."
  agent_type="browser"

→ [Browser Agent] browser_navigate http://localhost:3000/login
  → Renderer executes → page loads
→ [Browser Agent] browser_get_dom
  → Renderer returns indexed elements
→ [Browser Agent] browser_click index=12  (email input)
  → Renderer clicks → input focused
→ [Browser Agent] browser_type index=12 text="admin"
  → Renderer types → "admin" entered
→ [Browser Agent] browser_click index=15  (password input)
→ [Browser Agent] browser_type index=15 text="pass123"
→ [Browser Agent] browser_click index=18  (Sign In button)
→ [Browser Agent] browser_screenshot
  → Sees "Welcome, admin!" — login succeeded

→ [Browser Agent] Completed in 10 turns.
  Login test: SUCCESS. Navigated to login page,
  filled email and password fields, clicked Sign In.
  Result: "Welcome, admin!" displayed.
```

**Parallel example** — code-writer + researcher run simultaneously:

```
Agent: delegate_parallel tasks=[
  {task:"Implement POST /api/login in server/auth.ts", agent_type:"code-writer"},
  {task:"Research how existing API routes handle error responses", agent_type:"researcher"}
]

→ 2 sub-agents completed.
  [1] Wrote ~500 tokens to server/auth.ts. Build passed.
  [2] Found error handling pattern in server/middleware.ts:30-55...
```

#### When to use

- **`delegate_task`**: For a single complex sub-task that would take many turns (deep research, feature implementation, multi-file refactoring)
- **`delegate_parallel`**: For multiple independent sub-tasks that don't depend on each other (parallel research + implementation, multiple unrelated fixes)

### IDE-Driven Step-by-Step Execution (Force Todo)

In the default agent loop, the LLM controls when to create, update, and complete todos — it can skip steps, forget updates, or jump ahead. **Step-by-step mode** inverts this: the **IDE/server locks the todo list** and forces the agent through each step one at a time via isolated sub-agents.

#### How it works

```
User sends task → POST /api/chat/agent/stream/stepbystep

Phase 1: PLANNING
  Agent only has write_todos — no other tools
  Agent MUST create a complete, ordered plan
  → Server validates (non-empty, specific steps)

Phase 2: LOCKED
  Server locks the todo list → SSE "step_plan" event
  UI renders the locked plan in the pending banner

Phase 3: EXECUTE (per step)
  For each pending todo:
    → SSE "step_begin" event
    → Code-writer sub-agent spawned with ONLY this step's context
    → Sub-agent has full filesystem + run_command tools (max 25 iters)
    → Streaming tool_start/tool_end events shown in UI
    → Sub-agent calls task_complete → SSE "step_end" event
    → Step marked completed/failed, next step begins
  Previous step results are passed as context to subsequent steps

Phase 4: WRAP-UP
  → SSE "done" event with allStepResults summary
```

#### Key differences from default mode

| Aspect | Default Mode | Step-by-Step Mode |
|--------|-------------|-------------------|
| Planning | Agent can plan AND execute in same turn | Strict separation: plan first, execute later |
| Todo ownership | Agent-driven — LLM chooses when to update | IDE-driven — server locks todos, forces progression |
| Execution | Agent works on anything at any time | One step at a time, isolated sub-agent per step |
| Context | Full conversation history in one loop | Each step gets fresh sub-agent with only that step + previous results |
| Tool restriction | Full tool set available | Planning: only write_todos. Execution: code-writer tools (no browser/terminal) |
| Max turns | 50 per agent loop | Planning: 5 turns. Per step: 25 turns (configurable per agent profile) |

#### Why use it

- **Deterministic execution**: The server enforces todo progression — agent can't skip or forget steps
- **Isolated failures**: If a step's sub-agent fails, subsequent steps still run with clear failure context
- **Clean context per step**: Each step sub-agent starts fresh, avoiding context bloat from earlier steps
- **Verifiable progress**: The UI shows a locked plan with per-step status (pending → in_progress → completed/failed)

#### Summary Lock

Both default and step-by-step modes enforce **structured summaries** on `task_complete`. The server validates every summary against a required template:

```
### Changes Made
- [file path]: [what was changed]
### Verification
- [build/test/check result]
### Outcome
- [concise description of what was accomplished]
```

Summaries that are too short (< 30 chars), match thought-process patterns (e.g. "I did the task", "OK, completed"), or lack concrete details (no file references, actions, or results) are **rejected**. The agent receives the rejection as a tool error and must call `task_complete` again with a proper summary — the loop continues until a valid summary is provided.

### Persistent Memory

Harness includes a **cross-session memory system** backed by SQLite. The agent can store key decisions, user preferences, project conventions, and discovered patterns — and recall them in future sessions.

#### How it works

```
Agent detects an important fact
  → calls remember(key, value, category, tags)
  → value is optionally embedded via DeepSeek embeddings API
  → stored in .harness/memory.db (SQLite, per project)

Next session:
  → Agent calls recall(query: "UI framework")
  → Semantic search (cosine similarity) if embeddings exist
  → Falls back to keyword search if embedding API unavailable
  → Returns ranked results with scores
```

#### Tools

| Tool | Description |
|------|-------------|
| `remember` | Store a key decision, user preference, project convention, or important fact. Persists across sessions in SQLite. Categories: `decision`, `preference`, `convention`, `fact`, `pattern`, `general`. Tags help group related memories. The value is optionally embedded via DeepSeek API for semantic search. |
| `recall` | Search stored memories by semantic meaning or exact key. If embeddings are available, uses cosine similarity search. Otherwise falls back to keyword matching on key, value, tags, and category. Pass no params to list all memories. |
| `forget` | Remove a stored memory by its key. Use when a decision is reversed, a preference changes, or stored information becomes outdated. |

#### Storage

| Detail | Value |
|--------|-------|
| Database | SQLite (WAL mode) at `.harness/memory.db` per project root |
| Schema | `id`, `key` (unique), `value`, `category`, `tags`, `embedding` (BLOB), `created_at`, `updated_at` |
| Embeddings | Generated via DeepSeek `/v1/embeddings` endpoint (optional; graceful fallback to keyword search if unavailable) |
| Retrieval | Embedding cosine similarity search → keyword `LIKE` fallback → list-all |

#### When the agent uses memory

- **Proactive storage**: When the user says "let's use X", "I prefer Y", or establishes a project convention, the agent calls `remember` without being asked.
- **Session startup**: The agent is instructed to `recall` relevant memories at the start of a task to pick up past decisions and preferences.
- **Memory cleanup**: When preferences change or decisions are reversed, the agent can `forget` outdated entries.

#### Files

| File | Role |
|------|------|
| `server/memory.ts` | `MemoryStore` class — SQLite CRUD, embedding search, cosine similarity, singleton-per-project |
| `server/deepseek.ts` | `generateEmbedding()` — calls DeepSeek embeddings API, returns `Float32Array` |
| `server/agent.ts` | `runMemoryTool()` — tool execution handler; wired in both `agentLoop()` and `agentLoopStream()` |

## Agent Command Catalog

Every shell command the agent can potentially issue via `run_command` or `run_in_terminal`. These are extracted from the agent's system prompt chunks and the `detectProjectBuild()` auto-detection logic in [server/agent.ts](file:///d:/Work Projects/Harness/server/agent.ts).

### JavaScript / TypeScript

| Command | Usage | Source |
|---------|-------|--------|
| `npx tsc --noEmit` | Type-check all files (preferred) | `LANG_JS` + `detectProjectBuild` |
| `npm run build` | Full build via package.json scripts | `LANG_JS` + `detectProjectBuild` |
| `npx eslint .` | Lint all files | `LANG_JS` |
| `npm install` | Install all project dependencies | `LANG_JS` |
| `npm install <pkg>` | Install a specific package | `LANG_JS` |

### Python

| Command | Usage | Source |
|---------|-------|--------|
| `python -m py_compile <file>.py` | Single-file syntax check | `LANG_PYTHON` |
| `python -m compileall .` | Syntax check all .py files | `LANG_PYTHON` + `detectProjectBuild` |
| `python -m pytest` | Run tests | `LANG_PYTHON` |
| `pip install -r requirements.txt` | Install all project dependencies | `LANG_PYTHON` |
| `pip install <pkg>` | Install a single package | `LANG_PYTHON` + `SERVER_STARTUP` |

### Go

| Command | Usage | Source |
|---------|-------|--------|
| `go build ./...` | Compile all packages | `LANG_GO` |
| `go vet ./...` | Static analysis | `LANG_GO` + `detectProjectBuild` |
| `go test ./...` | Run all tests | `LANG_GO` |

### Rust

| Command | Usage | Source |
|---------|-------|--------|
| `cargo check` | Fast compile check (no binary) | `LANG_RUST` + `detectProjectBuild` |
| `cargo build` | Full compilation | `LANG_RUST` |
| `cargo test` | Run tests | `LANG_RUST` |
| `cargo clippy` | Lint with extra warnings | `LANG_RUST` |

### Java

| Command | Usage | Source |
|---------|-------|--------|
| `mvn compile` | Maven build | `LANG_JAVA` + `detectProjectBuild` |
| `gradle build` | Gradle build | `LANG_JAVA` |
| `gradle compileJava` | Gradle compile only | `detectProjectBuild` |
| `javac <File>.java` | Single file (no build tool) | `LANG_JAVA` |

### C / C++

| Command | Usage | Source |
|---------|-------|--------|
| `gcc -Wall -Wextra <file>.c -o output` | Single C file with warnings | `LANG_C` |
| `g++ -Wall -Wextra <file>.cpp -o output` | Single C++ file with warnings | `LANG_C` |
| `cmake --build build` | CMake projects | `LANG_C` + `detectProjectBuild` |
| `make` | Makefile projects | `LANG_C` + `detectProjectBuild` |

### Ruby

| Command | Usage | Source |
|---------|-------|--------|
| `ruby -c <file>.rb` | Syntax check (safe, no execution) | `LANG_RUBY` + `detectProjectBuild` |
| `bundle exec rake test` | Run tests via Rake | `LANG_RUBY` |
| `bundle exec rspec` | Run RSpec tests | `LANG_RUBY` |
| `bundle install` | Install gem dependencies | `LANG_RUBY` |
| `gem install <pkg>` | Install a single gem | `LANG_RUBY` |

### PHP

| Command | Usage | Source |
|---------|-------|--------|
| `php -l <file>.php` | Single file syntax lint | `LANG_PHP` |
| `php -l *.php` | Lint all PHP files | `LANG_PHP` + `detectProjectBuild` |
| `composer install` | Install dependencies | `LANG_PHP` |

### Shell (Bash)

| Command | Usage | Source |
|---------|-------|--------|
| `bash -n <script>.sh` | Syntax check without executing | `LANG_SHELL` |
| `shellcheck <script>.sh` | Static analysis (if installed) | `LANG_SHELL` |

### Cross-language / Generic

| Command | Usage | Source |
|---------|-------|--------|
| `git status --porcelain -u` | Staged/unstaged file tracking | Server SCM API |
| `git log --max-count=20` | Recent commit history | Server SCM API |
| `git diff -- <file>` | Show unstaged changes for a file | Server SCM API |
| `git fetch --all` | Fetch from all remotes | Server SCM API |
| `git pull` | Pull latest changes | Server SCM API |
| `git push` | Push local commits | Server SCM API |

### Project auto-detection (`read_problems`)

When the agent calls `read_problems`, the server auto-detects the project type and runs:

| Detection signal | Auto-command |
|------------------|-------------|
| `Cargo.toml` exists | `cargo check 2>&1` |
| `go.mod` exists | `go vet ./... 2>&1` |
| `pom.xml` exists | `mvn compile 2>&1` |
| `build.gradle` or `build.gradle.kts` exists | `gradle compileJava 2>&1` |
| `package.json` + `tsconfig.json` | `npx tsc --noEmit 2>&1` |
| `package.json` with build script | `npm run build 2>&1` |
| `package.json` (no tsconfig, no build script) | `npx tsc --noEmit 2>&1` |
| `requirements.txt` / `pyproject.toml` / `setup.py` / `.py` files | `python -m compileall . 2>&1` |
| `Gemfile` exists | `ruby -c *.rb 2>&1` |
| `composer.json` exists | `php -l *.php 2>&1` |
| `Makefile` exists | `make 2>&1` |
| `CMakeLists.txt` exists | `cmake --build build 2>&1` |
| None of the above | `npx tsc --noEmit` / `python -m compileall .` / `go vet ./...` (general suggestion) |

### Server-specific (via `run_in_terminal`)

Commands the agent is instructed to launch in a real terminal tab:

| Framework | Typical command | Mentioned in |
|-----------|----------------|-------------|
| Python (generic) | `python app.py` / `python server.py` | `run_command` block list |
| Flask | `flask run` | `run_command` block list |
| Django | `python manage.py runserver` | `run_command` block list |
| FastAPI | `uvicorn main:app` | `run_command` block list |
| Gunicorn | `gunicorn app:app` | `run_command` block list |
| Node.js (Express) | `node server.js` | `run_command` block list |
| npm scripts | `npm start` / `npm run dev` | `run_command` block list |
| Next.js | `next dev` / `next start` | `run_command` block list |
| Vite | `vite` | `run_command` block list |
| Go | `go run .` | `run_command` block list |
| Rust | `cargo run` | `run_command` block list |
| Webpack | `webpack-dev-server` | `run_command` block list |
| npx runners | `npx serve`, `npx vite`, `npx next` | `run_command` block list |

> **Note:** These server commands are BLOCKED in `run_command` and redirected to `run_in_terminal`. The agent is explicitly told to use `run_in_terminal` for all server start commands.

## Troubleshooting by Language

The agent knows how to diagnose and fix errors for each language stack. Below is the guidance it follows — useful to understand what the agent will do when your build fails.

### JavaScript / TypeScript

| Scenario | Tool | Command / Approach |
|---|---|---|
| Type-check | `run_command` | `npx tsc --noEmit` |
| Full build | `run_command` | `npm run build` (check `package.json` first) |
| Lint only | `run_command` | `npx eslint .` |
| Missing module | `run_command` | `npm install <pkg>` |
| Runtime errors in browser | `browser_console` | After starting dev server, check console output |
| Failed API calls | `browser_request_errors` | Check for 404/500/CORS errors in the browser |
| Find a definition | `grep` | Regex search across project files |

### Python

| Scenario | Tool | Command / Approach |
|---|---|---|
| Syntax check (single file) | `run_command` | `python -m py_compile <file>.py` |
| Syntax check (all files) | `run_command` | `python -m compileall .` |
| Run tests | `run_command` | `python -m pytest` |
| Install dependencies | `run_command` | `pip install -r requirements.txt` or `pip install <pkg>` |
| Flask/Django runtime errors | `browser_screenshot` or `browser_get_dom` | Flask debug mode shows full tracebacks in the browser |
| HTTP errors from backend | `browser_request_errors` | Check for 500 errors and CORS issues |
| Find where a function is defined | `grep` | `def <name>` or `class <Name>` |
| Read stack traces | `read_file` | Open the failing file at the line from the traceback |

### Go

| Scenario | Tool | Command / Approach |
|---|---|---|
| Compile check | `run_command` | `go build ./...` |
| Static analysis | `run_command` | `go vet ./...` |
| Run tests | `run_command` | `go test ./...` |
| Unused import | `edit_file` | Remove the import line (Go forbids unused imports) |
| Find definitions | `grep` | `func <Name>` or `type <Name>` |

### Rust

| Scenario | Tool | Command / Approach |
|---|---|---|
| Fast compile check | `run_command` | `cargo check` (preferred — no binary output) |
| Full build | `run_command` | `cargo build` |
| Lint | `run_command` | `cargo clippy` |
| Run tests | `run_command` | `cargo test` |

### Java

| Scenario | Tool | Command / Approach |
|---|---|---|
| Maven compile | `run_command` | `mvn compile` |
| Gradle build | `run_command` | `gradle build` |
| Single file compile | `run_command` | `javac <File>.java` |
| Find class definition | `grep` | `class <Name>` |

### C / C++

| Scenario | Tool | Command / Approach |
|---|---|---|
| Compile with warnings | `run_command` | `gcc -Wall -Wextra <file>.c -o output` |
| CMake build | `run_command` | `cmake --build build` |
| Make build | `run_command` | `make` |
| Find function definition | `grep` | `void <name>(` or `int <name>(` |

### Ruby

| Scenario | Tool | Command / Approach |
|---|---|---|
| Syntax check | `run_command` | `ruby -c <file>.rb` |
| Install deps | `run_command` | `bundle install` |
| Run tests | `run_command` | `bundle exec rspec` or `bundle exec rake test` |

### PHP

| Scenario | Tool | Command / Approach |
|---|---|---|
| Syntax lint | `run_command` | `php -l <file>.php` |
| Install deps | `run_command` | `composer install` |

### Shell (Bash)

| Scenario | Tool | Command / Approach |
|---|---|---|
| Syntax check | `run_command` | `bash -n <script>.sh` |
| Static analysis | `run_command` | `shellcheck <script>.sh` |

### General troubleshooting flow

1. **Start the server** (`run_in_terminal`) — user must Allow
2. **Check for build errors** (`run_command`) — fixes go through `edit_file` / `write_file`
3. **Verify the page loads** (`browser_info` → `browser_screenshot` / `browser_get_dom`)
4. **Check browser runtime errors** (`browser_console`, `browser_request_errors`)
5. **Read relevant source files** (`read_file`) before making fixes
6. **Make targeted edits** (`edit_file` — just send the lines that change)
7. **Rebuild and verify** — repeat until clean

### Avoiding tool hallucinations

The agent works with a fixed tool registry. To prevent it from inventing tools that don't exist:

- **Reading files** → use `read_file` (never `cat`, `head`, `tail`)
- **Listing directories** → use `list_files` (never `ls`, `dir`)
- **Finding files by name** → use `search_files` (never `find`, `locate`)
- **Searching file contents** → use `grep` (the tool, not the shell command)
- **Editing files** → use `edit_file` (never `sed`, `awk`)
- **Writing files** → use `write_file` (never `echo >`, `cp`)
- **Running commands** → use `run_command` for short tasks, `run_in_terminal` for servers (never background with `&` or `nohup`)
- **Checking diagnostics** → use `read_problems` (not `tsc`, `eslint`, or `pylint` directly — those go through `run_command`)
- **Starting servers** → use `run_in_terminal` only (never `run_command` for `python app.py`, `npm start`, etc.)

## MCP (Model Context Protocol)

Harness can act as an **MCP server**, exposing its filesystem, terminal, git, and system tools to any MCP-compatible client (Claude Desktop, Cursor, VS Code with Copilot, etc.).

### Which transport to use

The configuration depends on how you're running Harness:

| Scenario | Transport | Why |
|----------|-----------|-----|
| **Development** (source checkout) | Stdio or SSE | Both work; stdio gives you project isolation |
| **Electron desktop app** (packaged) | **SSE only** | The Express server already runs inside Electron on port 3001 — no extra process needed |

> **In an Electron app:** the Harness Express server starts inside the Electron main process. The MCP endpoints (`/api/mcp`, `/api/mcp/sse`) are available automatically on `http://localhost:3001`. You do NOT need a separate process or a `cwd` pointing to the source code — just connect via SSE.

### Development mode (source checkout)

When running Harness from source (`npm run dev`), you have both options:

#### Option A: SSE (simplest — no extra config)

Start the server, then point any MCP client at the running endpoint:

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://localhost:3001/api/mcp/sse"
    }
  }
}
```

Works with Claude Desktop, Cursor, VS Code, and any SSE-compatible client.

#### Option B: Stdio (project isolation)

Run a separate process per project. The `cwd` points to the Harness source checkout so `tsx` and the server files are found:

```powershell
npx tsx server/mcp-server.ts "D:\my-project"
```

Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "harness": {
      "command": "npx",
      "args": ["tsx", "server/mcp-server.ts", "D:\\my-project"],
      "cwd": "D:\\Work Projects\\Harness"
    }
  }
}
```

Cursor config (`Settings > MCP > Add Server`):

```json
{
  "mcpServers": {
    "harness": {
      "command": "npx",
      "args": ["tsx", "server/mcp-server.ts", "${workspaceFolder}"],
      "cwd": "D:\\Work Projects\\Harness"
    }
  }
}
```

### Electron desktop app (packaged)

When Harness is installed as a desktop app, the server is already running at `http://localhost:3001`. Use SSE transport only — no `command`/`cwd` needed:

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://localhost:3001/api/mcp/sse"
    }
  }
}
```

The embedded Express server handles all MCP requests. The project root is automatically set to the currently open project folder in the Harness UI, so tools like `read_file`, `grep`, and `run_command` operate on the right project automatically.

**Why stdio mode doesn't work well for packaged Electron apps:**

- There's no `tsx` runtime on the user's machine
- The source files (`server/mcp-server.ts`) are compiled/bundled, not on disk
- The Express server is already running inside Electron — spawning a second process is redundant

If you really need stdio from a packaged app, you can compile the MCP entry point to a standalone `.cjs` file and bundle it with the app. But SSE is the intended path.

### MCP tools

The following tools are exposed via MCP:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with line numbers or list a directory |
| `write_file` | Create or overwrite a file |
| `edit_file` | Targeted string replacement in a file |
| `list_files` | List files and directories at a path |
| `search_files` | Find files/folders by name pattern |
| `grep` | Search file contents with regex |
| `run_command` | Execute a shell command (sandboxed, no permission needed) |
| `create_directory` | Create a directory (and parent dirs) |
| `delete_file` | Delete a file or directory (recursive) |
| `rename_file` | Rename or move a file or directory |
| `git_status` | Get staged and unstaged git changes, current branch |
| `git_log` | Get recent commit history |
| `git_diff` | Get the diff for a specific file |
| `system_info` | Get CPU, memory, disk, OS details |

### Protocol details

Harness implements **MCP protocol version `2024-11-05`** with JSON-RPC 2.0:

1. **Initialize** — Client sends `initialize` → Server returns capabilities and server info
2. **List tools** — Client sends `tools/list` → Server returns tool definitions with JSON Schema
3. **Call tool** — Client sends `tools/call` → Server executes the tool and returns `{ content: [{ type: "text", text: "..." }] }`

The server only exposes **tools** capability — no resources or prompts.

### Example MCP exchange

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"harness","version":"1.0.0"}}}

→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}

→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"server/index.ts","limit":10}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"   1| import \"dotenv/config\";\n..."}],"isError":false}}
```

## Testing

Harness includes an automated test suite using [Vitest](https://vitest.dev). Tests cover all agent tools, the agent loop (with mocked DeepSeek API), tool schema validation, and API endpoints.

### Running tests

```powershell
# Run all tests once
npm test

# Run tests in watch mode (re-run on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run a specific test file
npx vitest run server/__tests__/agent.fs.test.ts
```

### Test structure

```
server/__tests__/
├── agent.fs.test.ts          # Filesystem tools: read_file, write_file, edit_file,
│                             #   list_files, search_files, grep, create_directory,
│                             #   delete_file, rename_file, write_todos (34 tests)
├── agent.command.test.ts     # Command tools: run_command, run_in_terminal,
│                             #   read_command_output (19 tests)
├── agent.loop.test.ts        # Blocking and streaming agent loops with mocked
│                             #   DeepSeek API responses (14 tests)
├── agent.tooldefs.test.ts    # Tool schema validation: required fields,
│                             #   no duplicate names, property integrity (6 tests)
└── api.test.ts               # Express endpoint integration tests: health,
│                             #   agent chat, filesystem APIs, project detection,
│                             #   system stats (12 tests)
```

### Test layers

| Layer | What's tested | Mock strategy |
|-------|--------------|---------------|
| **Tool definitions** | Every tool has valid JSON Schema, no duplicate names, required params have matching properties | None (static validation) |
| **Filesystem tools** | `runFsTool()` for each filesystem tool with real temp directories | Real filesystem |
| **Command tools** | `run_command` executes, blocks servers, returns exit codes; `read_command_output` pagination and filtering | Real `spawn` |
| **Agent loop** | `agentLoop()` and `agentLoopStream()`: tool selection logic, multi-turn loops, browser/permission handoff, iteration limits, reasoning content passthrough | Mocked DeepSeek API |
| **API endpoints** | Express routes: `/api/chat/agent`, `/api/chat/agent/stream`, `/api/health`, `/api/system/stats`, `/api/project/detect`, filesystem CRUD, session cleanup | Mocked DeepSeek, real supertest |

### Writing new tests

1. Tests use [Vitest](https://vitest.dev) globals (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`)
2. For agent loop tests, mock `chatDeepSeekTool` or `chatDeepSeekToolStream` from `server/deepseek.ts` to return controlled responses
3. Filesystem/command tests use `runFsTool()` with real temp directories created via `fs.mkdtempSync()`
4. API tests use `supertest` against the exported `app` from `server/index.ts`
5. Clean up temp directories in `afterEach` hooks

## Token Optimization (ITR + Context Caching + Live Compaction)

Harness uses four layers to reduce token usage and API costs when talking to DeepSeek:

### 1. Instruction-Tool Retrieval (ITR)

Instead of sending the entire system prompt on every agent turn, the prompt is broken into **14 themed chunks** in `server/agent.ts`:

| Chunk | Contents | When Included |
|---|---|---|
| **Core Rules** | Agent identity, workflow rules, file conventions | Always |
| **Browser Usage** | Browser tool reference, web element patterns (modals, dropdowns, autocomplete, etc.) | When `browser_*` tools are in use, or UI keywords detected |
| **Build & Fix Loop** | Compile → fix → repeat workflow | When errors, builds, or `edit_file`/`write_file` are detected |
| **Language-specific** (8 chunks) | JS/TS, Python, Go, Rust, Java, C/C++, Ruby, PHP, Shell troubleshooting | Detected from file extensions (`.py`, `.ts`, `.go`, etc.), config files (`package.json`, `go.mod`, `Cargo.toml`), and error patterns |
| **General Tips** | Multi-language detection, config file recognition | Always |
| **Server Startup** | Per-language server startup debugging (port conflicts, missing modules, etc.) | When `run_in_terminal` or server start commands are detected |
| **Diagnostics** | `read_problems`, `read_command_output` pagination, terminal usage | When `run_command`, `read_problems`, or build commands are detected |

The `buildSystemPrompt()` function in `server/agent.ts` scans the conversation history, tool call names, and file references at each turn, then assembles a **mini-prompt** containing only the relevant chunks. This reduces the system prompt by up to **~95%** compared to sending the full prompt every turn.

A typical turn without browser interaction sends only ~3 chunks (Core + Build/Fix + one language chunk) instead of all 14.

### 2. Context Caching

DeepSeek API supports **automatic prefix caching**: when consecutive requests share an identical message prefix (the system message), the server reuses the KV cache for those tokens — reducing both cost and latency.

Harness leverages this in two ways:

- **Stable system messages**: Because `buildSystemPrompt()` produces the same output for the same context, the system message stays stable across turns where the detected project stack doesn't change. DeepSeek hits the prefix cache automatically for these consecutive calls.
- **Cache tracking**: `server/deepseek.ts` computes a context ID from the system message content and logs cache metrics (`cacheRequests`, `cacheHits`) to `.harness-debug/` for observability.

No extra API parameters are needed — DeepSeek handles prefix caching transparently on the server side.

### 3. Rolling History Compaction

Long-running agent sessions now compact older plain-text turns on the server before building the next model request.

- Only older **plain chat turns** are compacted: `user` messages and non-tool `assistant` replies.
- The most recent plain turns stay verbatim so the model still sees the latest local context.
- Older plain turns are merged into a bounded **history summary** stored in the in-memory agent session.
- Tool-call ordering is preserved: assistant tool calls, tool results, pending permission state, and deferred file-accept/reject state are kept as structured messages.

This means the live prompt no longer grows linearly with every user/assistant exchange in long sessions.

Current defaults in `server/agent.ts`:

| Setting | Value | Effect |
|---|---|---|
| `HISTORY_COMPACTION_TRIGGER_MESSAGES` | `24` | Start compacting when the in-memory session grows beyond this many messages |
| `HISTORY_COMPACTION_TRIGGER_TOKENS` | `10000` | Also compact when the rough token estimate crosses this threshold |
| `HISTORY_PLAIN_MESSAGES_TO_KEEP` | `6` | Keep the latest plain turns verbatim |
| `HISTORY_SUMMARY_CHAR_BUDGET` | `2400` | Bound the rolling summary size |

### 4. Tool Result Distillation

Some tool outputs are much larger than what the model usually needs on the next turn.

Harness now distills bulky command/build output before storing it back into the agent transcript:

- `run_command` stores a compact summary instead of the full raw output
- `run_in_terminal` stores a compact summary (key error/success lines) instead of the full terminal log — the full output is cached for `read_command_output`
- `read_problems` stores a compact build-check summary instead of the full compiler/linter dump
- The summary keeps the most important lines (errors, warnings, failures, URLs, success markers)
- The **full raw command output is still cached** in the command-output store and can be re-read later with `read_command_output`

This cuts repeated replay of large terminal/compiler logs while keeping the raw output available on demand.

### 5. Context Token Estimation

The agent footer shows a live estimate of context usage: `~N / M tokens (X%) · T turns`. This is calculated on the server each agent turn and sent to the client via the SSE `done` event.

#### How it's calculated

```
estimatedTokens = round(totalChars / 4)

totalChars = sum of every char in state.messages
           + historySummary length
           + system prompt length
```

`state.messages` includes everything the model has seen or will see:
- User messages, assistant replies, and tool call JSON
- `reasoning_content` (DeepSeek's chain-of-thought — can be 10-30K chars per turn)
- Tool result content (file contents, command output summaries, browser snapshots)
- `tool_call_id` UUIDs and function `name` fields

The system prompt is built fresh each turn by ITR chunk selection and is added to the estimate (it's not stored in `state.messages`).

#### Accuracy

| Factor | Note |
|--------|------|
| **`chars / 4`** | Rough heuristic. DeepSeek's byte-level BPE tokenizer varies: code/text is typically 2-3 chars/token, CJK ~1 char/token. Can be off by up to 2x. |
| **System prompt** | Counted. Built from ITR chunks (3-15K chars / 0.75-3.75K tokens). |
| **`reasoning_content`** | Counted. DeepSeek R1/reasoner models produce verbose chain-of-thought. |
| **Console context** | NOT counted. The IDE's diagnostic/terminal context is small and passed separately for ITR selection. |
| **NOT_EXECUTED injections** | NOT counted. These are injected by `buildOpenAiMessages` at API-call time and not stored in `state.messages`. |

#### Context limit

The `contextLimit` is set dynamically based on the model name:

| Model pattern | Context window |
|---------------|---------------|
| `deepseek-chat` (V3), `deepseek-reasoner` (R1) | 128,000 tokens |
| Models containing `v4`, `pro`, or `flash` | 1,000,000 tokens |
| Unknown / custom | 128,000 tokens (default) |

#### Cumulative turns

The `turns` counter accumulates across the entire session, not per-response. The server sends `turns = iter + 1` (iterations in that agent turn), and the client sums them into `totalTurnsRef`.

### Architecture

```
                ┌─────────────────────────────┐
                │    buildSystemPrompt()      │
                │  scans messages + context   │
                │  selects relevant chunks    │
                └──────────────┬──────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Rolling compaction   │
                    │ + history summary    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Tool result          │
                    │ distillation         │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Mini system prompt   │
                    │ + compact transcript │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ deepseekFetch()      │
                    │ + cacheContextId     │
                    │ → DeepSeek API       │
                    └─────────────────────┘
```

Files:
- `server/agent.ts` — `buildSystemPrompt()`, rolling history compaction, tool-result distillation, prompt assembly
- `server/deepseek.ts` — `deepseekFetch()` with `cacheContextId` parameter, cache metrics logging
