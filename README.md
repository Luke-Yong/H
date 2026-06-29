# Harness

AI-powered browser test runner using Monaco Editor, Playwright, and DeepSeek.

## Setup

```powershell
# Install dependencies
npm run install:all

# Install Playwright browser
npx playwright install chromium
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
The AI agent has five filesystem tools:

| Tool | Description |
|------|-------------|
| `read_file` | Reads a file with line numbers |
| `write_file` | Creates or overwrites a file |
| `list_files` | Lists directory contents (skips `.git` / `node_modules`) |
| `create_directory` | Creates a new directory (and any parent dirs) |
| `delete_file` | Deletes a file or directory (recursively) |

All tools operate relative to the project root. The agent can browse, create, edit, and clean up files on its own — no manual intervention needed.

**Server APIs**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fs/create-file` | POST | Creates a file (and parent dirs) if it doesn't already exist |
| `/api/fs/delete` | DELETE | Deletes a file or directory (recursive for dirs) |
| `/api/fs/rename` | POST | Renames / moves a file or directory |

## How it works

1. Write HTML/CSS/JS in the Monaco Editor
2. Click **Run Test** — code gets injected into a Playwright browser
3. The DOM is extracted and sent to DeepSeek with your test goal
4. DeepSeek returns actions (click/type) which Playwright executes
5. Results and screenshots stream back in real-time

## Agent Tools (DeepSeek-powered)

The AI agent has access to these tools when working on your project:

### Filesystem

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with line numbers — always read before editing |
| `write_file` | Create or overwrite a file (accept/reject before applying) |
| `list_files` | List files and directories in a given path |
| `search_files` | Recursively find files/folders by name pattern (case-insensitive) |
| `grep` | Search file contents for a regex pattern — find definitions, usages |
| `create_directory` | Create a directory (and parents) |
| `delete_file` | Delete a file or directory recursively |

### Terminal

| Tool | Description |
|------|-------------|
| `run_command` | Run a shell command in the project root (30s timeout, stdout+stderr returned) |

### Browser

| Tool | Description |
|------|-------------|
| `browser_screenshot` | Capture a screenshot of the current page |
| `browser_get_dom` | Get indexed clickable/typable elements from the page |
| `browser_click` | Click an element by DOM index |
| `browser_type` | Type text into an input by DOM index |
| `browser_eval` | Run arbitrary JavaScript in the page |
| `browser_navigate` | Navigate to a URL |

### Control

| Tool | Description |
|------|-------------|
| `task_complete` | Signal completion with a summary of what was done |
