# H

**AI 编程助手。** 27 个工具、11 种子 Agent 类型，基于 DeepSeek。  
内存占用约 VS Code 的 1/6，磁盘占用约 1/5。

[English](README.md) · [完整架构 →](ARCHITECTURE_CN.md)

![H 截图](demo.png)

---

## 为什么选择 H 而不是 VS Code OSS？

| | H | VS Code OSS |
|---|---|---|
| **RAM（空闲）** | ~200–300 MB | ~1–2 GB |
| **磁盘占用** | ~200–300 MB | ~1–2 GB |
| **AI 原生** | 内置 Agent 循环，27 个工具 | 仅扩展（Copilot、Continue） |
| **Agent 类型** | 11 种专用子 Agent（浏览器、代码编写、研究、规划、安全审计、架构分析…） | 无内置 |
| **浏览器** | 内置 Electron webview + DOM 索引 | 无 |
| **终端** | PTY 支持（node-pty），Agent 可访问 | 集成终端（Agent 无法访问） |
| **知识图谱** | 自动构建代码库图谱（.kg），含符号级导入关系 | 无 |
| **多 Agent** | `delegate_task` 实时流式传输 + 颜色编码 UI | 无 |
| **MCP** | 内置 MCP 服务器（stdio + SSE） | 仅扩展 |
| **持久化记忆** | SQLite 支持的跨会话记忆 | 无 |
| **文件追踪** | 自动检测 Git 与监视器模式 | 仅 Git |
| **分步执行** | IDE 锁定的 Todo 推进，隔离子 Agent | 无 |
| **许可证** | AGPL-3.0 | MIT |

H 不是一个编辑器平台 — 它是一个 **Agent 优先的工作空间**。每个功能都是为 AI 直接使用而设计的：文件系统工具、沙箱命令、浏览器自动化、终端 PTY、以及跨 11 个 Agent 配置文件的结构化委托。

---

## 快速开始

```powershell
npm run install:all
npm run dev
```

在 [platform.deepseek.com](https://platform.deepseek.com) 获取 API Key。

---

## Agent 工具（共 27 个）

| 类别 | 工具 |
|---|---|
| **文件系统** | `read_file`、`write_file`、`edit_file`、`list_files`、`search_files`、`grep`、`create_directory`、`rename_file`、`delete_file` |
| **终端** | `run_command`（沙箱）、`run_in_terminal`（真实 PTY）、`kill_terminal`、`read_command_output` |
| **浏览器** | `browser_navigate`、`browser_info`、`browser_screenshot`、`browser_get_dom`、`browser_click`、`browser_type`、`browser_clear`、`browser_select`、`browser_scroll`、`browser_press_key`、`browser_wait`、`browser_move_mouse`、`browser_right_click`、`browser_upload_file`、`browser_console`、`browser_request_errors` |
| **诊断** | `read_problems`、`read_graph` |
| **控制** | `write_todos`、`write_summary`、`task_complete`、`delegate_task` |
| **记忆** | `remember`、`recall`、`forget` |

## 子 Agent 配置（11 种）

`browser` · `code-search` · `code-writer` · `researcher` · `planner` · `frontend-specialist` · `backend-specialist` · `security-auditor` · `architect-analyst` · `docs-analyst` · `documentation-writer`

每个子 Agent 在其独立的上下文窗口中运行。父 Agent 委托任务并将结果实时流式传输到 UI，每种 Agent 类型有独特的颜色编码。

---

## 技术栈

- **客户端：** React 18、Vite、Monaco 编辑器、xterm.js
- **服务端：** Node.js、Express、WebSocket (ws)、node-pty、better-sqlite3
- **AI：** DeepSeek API（工具调用、嵌入、前缀缓存）
- **桌面：** Electron
- **LSP：** 30+ 语言服务器（pyright、gopls、rust-analyzer、clangd、jdtls…）

---

## 许可证

AGPL-3.0 — 详见 [LICENSE](LICENSE)。  
版权所有 (c) 2026 Luke Yong。

---

*~250 MB RAM，~250 MB 磁盘。Agent 优先。开源。*

---
**ai coding agent · deepseek · electron · react · typescript · 多agent · mcp · lsp · 知识图谱 · 浏览器自动化 · 终端 · 子agent委托**
