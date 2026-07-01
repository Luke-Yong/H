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

**2. Language Server (LSP):** For everything else, Harness talks to a standard language server over stdio (`server/lsp.ts`). Diagnostics are pushed to `/api/lsp/diagnostics` (debounced while editing) and surfaced in the editor tab, the left glyph column, the overview ruler, and the Problems panel.

A language server is only used **if its executable is found on your `PATH`**. If it isn't installed, that language is simply skipped — no errors, no setup required.

### Supported languages and their servers

| Language        | Server binary                  | Install (example)                                      |
| --------------- | ------------------------------ | ------------------------------------------------------ |
| Python          | `pylsp`                        | `pip install python-lsp-server pyflakes`               |
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
| `run_in_terminal` | **User permission** | User must explicitly Allow each command before it runs in a terminal tab. |
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
| `run_command` | **Sandbox** | Run a shell command with inline output. Fast, no permission needed. Use for: tests, lint, git, pip, npm, builds, grep. Output appears directly in the tool card. |
| `run_in_terminal` | **Real terminal** | Run a long-running command in a dedicated terminal tab. User must Allow each command. Use for: `python app.py`, `npm start`, flask, watch mode, interactive shells. Command runs in background — agent continues immediately. Output streams to both the terminal tab and the agent tool card via a bridge. |

### Browser

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL (http/https only) |
| `browser_info` | Get current browser tab URL and load status |
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
| `write_todos` | Create or update a structured task list to track progress |
| `task_complete` | Signal completion with a summary of what was done |
