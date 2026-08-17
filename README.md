# H

**AI coding agent.** 27 tools, 11 sub-agent types, DeepSeek-powered.  
~5× less RAM & disk than VS Code.

[中文文档](README_CN.md) · [Full Architecture →](ARCHITECTURE.md)

![H screenshot](demo.png)

---

## Tier 1 — vs VS Code OSS (Efficiency)

The lightweight baseline. H cuts the overhead of a general-purpose editor platform by focusing strictly on what an agent needs.

| | H | VS Code OSS |
|---|---|---|
| **RAM (idle)** | ~200–300 MB | ~1–2 GB |
| **Disk size** | ~200–300 MB | ~1–2 GB |
| **Startup** | ~2–3 s (cold) | ~5–10 s (cold) |
| **Process model** | 3–5 processes (Electron + Node server) | 15–30+ processes (extension hosts, LSPs, watchers, shared workers) |
| **Focus** | Agent-first workspace | Extensible editor platform |
| **License** | AGPL-3.0 | MIT |

## Tier 2 — vs VS Code OSS + Copilot (Scope)

Copilot is a code **assistant** — autocomplete, chat, and inline suggestions. H is **agent-native**: it plans, delegates, remembers, and operates the browser and terminal directly.

| | H | VS Code OSS + Copilot |
|---|---|---|
| **Model** | **Agent** — plans, executes end-to-end tasks, iterates on its own errors | **Assistant** — responds to prompts, suggests snippets, requires the user to drive |
| **Delegation** | `delegate_task` — spawns 11 specialized sub-agents (browser, code-writer, researcher, security-auditor, architect…) with isolated context windows | None — single chat thread |
| **Live sub-agent UI** | Per-agent color-coded streaming, progress cards, nested todos | None |
| **Persistent memory** | File-based cross-session memory (`remember` / `recall` / `forget`) | Per-session chat only |
| **Browser automation** | Built-in Electron webview + 16 browser tools (click, type, upload, console, network, DOM) | None |
| **Terminal control** | `run_in_terminal` — real PTY with agent read/write/kill access | Integrated terminal, no agent access |
| **Knowledge graph** | Auto-built codebase graph (.kg): symbol-level imports, stdlib/third-party classification, unused-import detection, `read_graph` tool (6 query types) | None |
| **Multi-agent orchestration** | Parent → child agent handoff with streaming summaries | None |
| **Step-by-step locking** | IDE-enforced todo progression — sub-agents can't skip ahead | None |
| **Tool count** | 27 built-in primitives | Copilot-only feature set (no browser/terminal/graph) |
| **MCP** | Built-in MCP server (stdio + SSE) | Extensions only |

H is not an editor and not a chat panel — it's a **self-driving workspace**. The agent owns the task loop: it reads and writes files, runs commands, opens web pages, spawns specialist sub-agents for subtasks, and tracks progress on a locked todo list that the user can follow but the agent can't shortcut.

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
- **Server:** Node.js, Express, WebSocket (ws), node-pty
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
