```
██╗  ██╗
██║  ██║
███████║
██╔══██║
██║  ██║██╗
╚═╝  ╚═╝╚═╝
```

# Hey, I'm Luke — I'm building **H**, the agent-native IDE.

**Replacing VS Code with a self-driving AI workspace.**  
27 tools · 11 sub-agents · ~250 MB RAM · runs 100% local.

<p align="center">
  <a href="https://github.com/Luke-Yong/H">
    <img src="https://img.shields.io/github/stars/Luke-Yong/H?style=for-the-badge&logo=github&color=e1251b&labelColor=111111" alt="Star H on GitHub">
  </a>
  &nbsp;
  <a href="https://github.com/Luke-Yong">
    <img src="https://img.shields.io/github/followers/Luke-Yong?style=for-the-badge&logo=github&color=ae852d&labelColor=111111" alt="Follow me">
  </a>
  &nbsp;
  <a href="https://github.com/Luke-Yong/H">
    <img src="https://img.shields.io/badge/AGPL--3.0-Open%20Source-53575a?style=for-the-badge&labelColor=111111" alt="AGPL-3.0">
  </a>
</p>

---

## ⚡ What H does

H is not an editor with AI bolted on. It's an **AI agent that lives inside your codebase.**

You give it a task. H breaks it into a locked todo list, spawns specialist sub-agents for research, security, frontend, architecture — writes code, runs terminals, opens browsers, tests, and iterates. Autonomously. You watch the green bars fill.

```powershell
npm run install:all ; npm run dev
```

Two commands. That's it.

---

## 🌟 Why you'll star this

### 1. Agent-native. Not assistant-glued-on.

Copilot autocompletes. H **owns the task loop.**  
It plans, delegates, remembers across sessions (SQLite), catches its own mistakes, and fixes them — without you driving every keystroke.

### 2. Eleven specialist sub-agents. The right brain for every job.

| Sub-agent | Specialization |
|---|---|
| `code-search` | Knowledge-graph traversal at symbol level |
| `code-writer` | Implementation + lint-clean passes |
| `browser` | Electron webview — clicks, types, uploads, reads DOM |
| `frontend-specialist` | React / Monaco / xterm deep changes |
| `backend-specialist` | Express, WebSocket, node-pty, LSP wiring |
| `security-auditor` | Injection, secrets, auth — pre-merge gate |
| `architect-analyst` | Module boundaries & dependency reviews |
| `docs-analyst` | Reads specs, architecture, past decisions |
| `documentation-writer` | Generates specs, READMEs, inline docs |
| `researcher` | Web search, RFC retrieval, pattern matching |
| `planner` | Decomposes tasks into locked todo sequences |

Each sub-agent runs in its **own isolated context window.** Color-coded, live-streamed to the UI so you see exactly who's doing what.

### 3. ~250 MB RAM. ~250 MB disk. 2–3 second cold start.

VS Code OSS: 1–2 GB idle, 15–30 processes.  
H: 3–5 processes for the entire agent loop, editor, and LSP stack.

That's not an optimization — it's a **different process model,** designed for agents from scratch.

### 4. Twenty-seven built-in tools. Zero extensions needed.

| Filesystem | `read_file` `write_file` `edit_file` `list_files` `search_files` `grep` `create_directory` `rename_file` `delete_file` |
|---|---|
| **Terminal** | `run_command` (sandbox) `run_in_terminal` (real PTY) `kill_terminal` `read_command_output` |
| **Browser** | `navigate` `screenshot` `get_dom` `click` `type` `clear` `select` `scroll` `press_key` `wait` `move_mouse` `right_click` `upload_file` `console` `request_errors` |
| **Diagnostics** | `read_problems` (LSP) `read_graph` (knowledge graph) |
| **Control** | `write_todos` `write_summary` `task_complete` `delegate_task` |
| **Memory** | `remember` `recall` `forget` — cross-session, SQLite-backed |

### 5. Actually open source. AGPL-3.0.

No telemetry. No phone-home. Your code never leaves your machine — unless you explicitly tell the browser agent to go somewhere.

---

## 🧱 The stack

```
┌──────────────────────────────────────────────────┐
│  React 18  ·  Monaco  ·  xterm.js   (Electron)   │  ~200 MB
├──────────────────────────────────────────────────┤
│  Express  ·  WebSocket  ·  node-pty  ·  SQLite   │  Agent server
├──────────────────────────────────────────────────┤
│  30 LSPs  (pyright · gopls · rust-analyzer …)    │  On-demand
├──────────────────────────────────────────────────┤
│  DeepSeek API  (tool-calling · embeddings · cache)│  AI brain
└──────────────────────────────────────────────────┘
```

[Full architecture doc &rarr;](https://github.com/Luke-Yong/H/blob/main/ARCHITECTURE.md)

---

## 🚧 Roadmap

H is early. I'm squashing bugs daily and shipping fixes. The near-term focus:

- **Stability** — edge-case fixes across sub-agent streaming, terminal PTY, and LSP startup
- **Windows installer** — one-click `.exe` setup so you don't need Node.js
- **Docs & onboarding** — better quickstart, architecture guides, video walkthroughs

Bigger ideas (once the foundation is solid): MCP marketplace, composite agent pipelines

---

## 🤝 Contribute

H is **AGPL-3.0** and open to contributions. Good first issues are tagged in the repo.

- Bug reports and small fixes are hugely appreciated right now
- Know Electron, React, or node-pty? There are meaty problems to solve
- Open an issue to discuss before sending a big PR — I'm responsive

```bash
git clone https://github.com/Luke-Yong/H.git
cd H
npm run install:all
npm run dev
```

Pick up an issue, open a PR, and let's build this together.

<p align="center">
  <a href="https://github.com/Luke-Yong">
    <img src="https://img.shields.io/badge/Follow_for_updates-ae852d?style=for-the-badge&labelColor=111111">
  </a>
  &nbsp;
  <a href="https://github.com/Luke-Yong/H/issues">
    <img src="https://img.shields.io/badge/Good_first_issues-53575a?style=for-the-badge&labelColor=111111">
  </a>
</p>

---

## ⭐ Star the repo

Two seconds. Every star tells me where to focus next — and brings in more contributors.

<p align="center">
  <a href="https://github.com/Luke-Yong/H">
    <img src="https://img.shields.io/badge/★_Star_H_·_agent_native_IDE-e1251b?style=for-the-badge&labelColor=111111">
  </a>
</p>

---

## 📌 Pinned

| Project | One-liner |
|---|---|
| [**H**](https://github.com/Luke-Yong/H) | Agent-native IDE · 27 tools · 11 sub-agents · ~250 MB RAM |
| [ARCHITECTURE](https://github.com/Luke-Yong/H/blob/main/ARCHITECTURE.md) | Process model, agent loop, LSP wire-up — the full spec |
| [PAPERS &amp; PATTERNS](https://github.com/Luke-Yong) | Reading log: multi-agent orchestration, MCP, tool-calling |

---

> **"The best IDE is the one the AI actually uses."**
