# H

**AI coding agent.** 27 tools, 11 sub-agent types, DeepSeek-powered.  
~5× less RAM & disk than VS Code.

[中文文档](README_CN.md) · [Full Architecture →](ARCHITECTURE.md)

![H screenshot](demo.png)

---

## Why H over VS Code OSS?

| | H | VS Code OSS |
|---|---|---|
| **RAM (idle)** | ~200–300 MB | ~1–2 GB |
| **Disk size** | ~200–300 MB | ~1–2 GB |
| **AI-native** | Built-in agent loop with 27 tools | Extensions only (Copilot, Continue) |
| **Agent types** | 11 specialized sub-agents (browser, code-writer, researcher, planner, security-auditor, architect…) | None built-in |
| **Browser** | Built-in Electron webview + DOM indexing | None |
| **Terminal** | PTY-backed (node-pty) with agent access | Integrated terminal (no agent access) |
| **Knowledge graph** | Auto-built codebase graph (.kg) with symbol-level imports | None |
| **Multi-agent** | `delegate_task` with live streaming + color-coded UI | None |
| **MCP** | Built-in MCP server (stdio + SSE) | Extensions only |
| **Persistent memory** | SQLite-backed cross-session memory | None |
| **File tracking** | Auto-detects Git vs watcher mode | Git only |
| **Step-by-step** | IDE-locked todo progression with isolated sub-agents | None |
| **License** | AGPL-3.0 | MIT |

H is not an editor platform — it's an **agent-first workspace**. Every feature is designed for the AI to use directly: filesystem tools, sandboxed commands, browser automation, terminal PTY, and structured delegation across 11 agent profiles.

---

## Quick Start

```powershell
npm run install:all
npm run dev
```

Get a key at [platform.deepseek.com](https://platform.deepseek.com).

---

## Agent Tools (27 total)

| Category | Tools |
|---|---|
| **Filesystem** | `read_file`, `write_file`, `edit_file`, `list_files`, `search_files`, `grep`, `create_directory`, `rename_file`, `delete_file` |
| **Terminal** | `run_command` (sandbox), `run_in_terminal` (real PTY), `kill_terminal`, `read_command_output` |
| **Browser** | `browser_navigate`, `browser_info`, `browser_screenshot`, `browser_get_dom`, `browser_click`, `browser_type`, `browser_clear`, `browser_select`, `browser_scroll`, `browser_press_key`, `browser_wait`, `browser_move_mouse`, `browser_right_click`, `browser_upload_file`, `browser_console`, `browser_request_errors` |
| **Diagnostics** | `read_problems`, `read_graph` |
| **Control** | `write_todos`, `write_summary`, `task_complete`, `delegate_task` |
| **Memory** | `remember`, `recall`, `forget` |

## Sub-Agent Profiles (11 types)

`browser` · `code-search` · `code-writer` · `researcher` · `planner` · `frontend-specialist` · `backend-specialist` · `security-auditor` · `architect-analyst` · `docs-analyst` · `documentation-writer`

Each sub-agent runs in its own isolated context window. The parent agent delegates tasks and streams results live to the UI with per-agent color coding.

---

## Tech Stack

- **Client:** React 18, Vite, Monaco Editor, xterm.js
- **Server:** Node.js, Express, WebSocket (ws), node-pty, better-sqlite3
- **AI:** DeepSeek API (tool-calling, embeddings, prefix caching)
- **Desktop:** Electron
- **LSP:** 30+ language servers (pyright, gopls, rust-analyzer, clangd, jdtls…)

---

## License

AGPL-3.0 — see [LICENSE](LICENSE).  
Copyright (c) 2026 Luke Yong.

---

*~250 MB RAM, ~250 MB disk. Agent-first. Open source.*

---
**ai coding agent · deepseek · electron · react · typescript · multi-agent · mcp · lsp · knowledge graph · browser automation · terminal · sub-agent delegation**
