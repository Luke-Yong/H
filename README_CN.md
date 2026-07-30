# Harness

基于 DeepSeek 的 AI 编程助手。

## 目录

- [环境配置](#环境配置)
- [配置说明](#配置说明)
- [启动](#启动)
- [架构](#架构)
  - [服务端](#服务端server)
  - [客户端](#客户端client)
  - [数据流（Agent 回合）](#数据流agent-回合)
  - [Agent 循环内部机制](#agent-循环内部机制)
- [桌面版 (Electron)](#桌面版-electron)
- [内置浏览器](#内置浏览器桌面版)
- [语言支持 (LSP)](#语言支持-lsp)
- [文件管理](#文件管理)
- [智能文件追踪](#智能文件追踪)
- [知识图谱](#知识图谱)
- [安全](#安全)
- [Agent 工具 (DeepSeek 驱动)](#agent-工具-deepseek-驱动)
  - [文件系统](#文件系统)
  - [终端](#终端)
  - [浏览器](#浏览器)
  - [多 Agent 委托](#多-agent-委托)
  - [IDE 驱动的分步执行 (强制 Todo)](#ide-驱动的分步执行-强制-todo)
  - [持久化记忆](#持久化记忆)
- [Agent 命令目录](#agent-命令目录)
- [按语言排查问题](#按语言排查问题)
- [MCP (模型上下文协议)](#mcp-模型上下文协议)
- [项目结构](#项目结构)
- [测试](#测试)
- [Token 优化 (ITR + 上下文缓存 + 实时压缩)](#token-优化-itr--上下文缓存--实时压缩)
  - [ITR](#1-指令-工具检索-itr)
  - [上下文缓存](#2-上下文缓存)
  - [子 Agent 前缀缓存](#2b-子-agent-前缀缓存)
  - [历史压缩](#3-滚动历史压缩)
  - [工具结果精简](#4-工具结果精简)

## 环境配置

```powershell
# 安装依赖
npm run install:all
```

## 配置说明

Harness 使用**客户端输入 API Key** 的模式。在 Harness UI 的模型选择器中输入 DeepSeek API Key：

1. 点击 Agent 控制台中的模型选择器
2. 输入你的 API Key（以 `sk-...` 开头）
3. 点击保存

Key 会一次性发送到服务器并持久化存储在磁盘上（`~/.harness/store/api-keys.enc`，AES-256-GCM 加密）——它永远不会存储在浏览器的 `localStorage` 中，在应用重启和更新后仍然有效，并且永远不会在 Agent 请求体中重新发送。Key 会一直保留，直到通过 UI 中的"移除 API Key"或删除 `~/.harness/` 目录来显式移除。

所有客户端状态（选中的模型、聊天记录、最近文件夹路径、打开的编辑器标签页、模型预设、终端历史）都存储在浏览器的 `localStorage` 中，并在每次变更和应用退出时**同步镜像到 `~/.harness/store/client-state.json`**。这确保数据在重装后仍然存在，因为 `%USERPROFILE%\.harness\` 位于 Electron 安装程序的作用域之外。启动时，客户端会获取 `GET /api/client/state` 并恢复之前保存的所有状态。

在 [platform.deepseek.com](https://platform.deepseek.com) 获取 API Key。

## 启动

```powershell
npm run dev
```

此命令同时启动后端和前端。操作系统会分配两个端口；请查看控制台输出获取 URL。

**端口发现流程：**

1. Express 启动 → `server.listen(0)` → 操作系统分配空闲端口 → 端口写入 `%TEMP%/harness-ports/express-port`
2. Vite 立即启动（不阻塞）→ 通过中间件代理 `/api`、`/ws`、`/_browser`，该中间件在每次请求时读取 `%TEMP%/harness-ports/express-port` → 在 Express 可用之前返回 `503 Service Unavailable`，之后就正常转发
3. Vite 绑定 → `port: 0` → 操作系统分配空闲端口 → 端口写入 `%TEMP%/harness-ports/vite-port`
4. Electron（桌面模式）读取这两个文件以连接 Express 并加载 Vite 开发页面

两个服务器都让操作系统自主决定端口 — 没有任何硬编码的端口号。

**过期端口清理：** 在关闭时（Ctrl+C、SIGTERM），Express 会删除端口文件。如果 Express 意外崩溃导致文件残留，Vite 代理中间件会检测到死端口（`ECONNREFUSED`），使缓存的端口失效，并在下次请求时重新读取文件。端口文件存储在 `%TEMP%/harness-ports/`（系统临时目录）以避免沙箱环境的文件系统权限问题。

**单实例锁：** 桌面应用使用自定义 PID 文件锁替代 Electron 的 `app.requestSingleInstanceLock()`（Windows 沙箱环境下不可靠）。启动时将当前 PID 写入 `%TEMP%/harness-pid`；如果 PID 文件已存在且对应进程仍存活，新实例将退出。正常关闭时删除 PID 文件。这避免了端口文件冲突和共享状态（`~/.harness/` 文件）损坏的问题。

**文件完整性：** 所有 `~/.harness/` 文件仅存储在用户本机。如被外部修改，影响为非破坏性的——应用会检测损坏并优雅重置：

| 文件 | 如被篡改 |
|------|----------|
| `ports/express-port` | `waitForOwnServerPort` 通过 `/api/health` + PID 校验验证端口。PID 不匹配 → 超时 → 应用显示启动错误。 |
| `ports/vite-port` | Electron 加载错误 URL → 连接被拒绝 → 加载页面超时。 |
| `store/client-state.json` | `JSON.parse` 失败 → 所有状态重置为默认值。有效但错误的 JSON → UI 显示错误的模型/路径；模型字符串仅导致 API 调用失败；路径仅显示，不会自动打开。 |
| `store/api-keys.enc` | AES-256-GCM 认证标签解密不匹配 → API 密钥重置。文件在没有 `~/.harness/.key` 机器密钥的情况下不可读。 |
| `store/memory.db` | SQLite 损坏 → 记忆功能重置。 |
| `.key` | 被替换或删除 → 现有 `api-keys.enc` 永久不可读（下次保存时生成新密钥）。 |

## 架构

Harness 是一个客户端-服务器应用，可选配 Electron 桌面壳。

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 壳 (桌面模式)                                     │
│  ┌──────────────────────────┐  ┌──────────────────────────┐ │
│  │  客户端 (React + Vite)   │  │  服务端 (Express + WS)   │ │
│  │                          │  │                          │ │
│  │  Monaco 编辑器           │  │  Agent 循环 (工具调用)   │ │
│  │  xterm.js 终端           │  │  LSP stdio 桥接          │ │
│  │  Agent 控制台 (SSE)      │  │  终端管理器 (PTY)        │ │
│  │  文件树 / SCM 面板       │  │  浏览器反向代理          │ │
│  │  浏览器 webview          │  │  Git / FS / System API   │ │
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

### 服务端（`server/`）

Node.js Express 服务器是骨干。它拥有所有后端逻辑，从不在浏览器中运行。操作系统在启动时分配空闲端口，并写入 `%TEMP%/harness-ports/express-port` 以供发现。

| 层 | 文件 | 职责 |
|---|---|---|
| HTTP API | `server/index.ts` | 文件系统 CRUD、git 状态/提交/差异、项目检测、系统状态以及 agent 聊天（阻塞 + SSE 流式 + 分步）的 REST 端点 |
| Agent 循环 | `server/agent.ts` | 工具调用编排：接收用户消息，向 DeepSeek 发送工具定义，执行文件系统/终端工具，管理浏览器工具切换，压缩对话历史 |
| DeepSeek 桥接 | `server/deepseek.ts` | 原始 DeepSeek API 调用 — 聊天、工具调用和 SSE 流式 — 带前缀缓存跟踪以及 API 支持的用量和缓存 token 报告 |
| LSP 桥接 | `server/lsp.ts` | 通过 stdio 启动语言服务器，将诊断信息转发给客户端，处理补全和悬停提示 |
| 终端管理器 | `server/terminalManager.ts` | 为每个会话创建 shell 进程（通过 `node-pty` 的 PTY 或管道回退），在客户端 WebSocket 消息和子进程 stdio 之间路由 I/O，自动检测终端输出中的 localhost URL |
| 浏览器代理 | `server/index.ts` (`/_browser`) | 通过服务器反向代理外部 URL，使客户端 iframe 保持同源，移除 `X-Frame-Options` 头，注入限制性 CSP |

**与客户端之间的 3 个传输通道：**

- **HTTP** — 标准 REST，用于文件读写、git 操作、LSP 诊断、agent 聊天初始化
- **SSE（服务器推送事件）** — Agent 回话期间用于 agent 思考/文本/工具事件的单向流式传输
- **WebSocket** — 双向传输，用于终端 I/O（`term:create`、`term:write`、`term:resize`、`term:kill`）以及服务器到客户端的广播（日志、错误、浏览器 URL 检测）

### 客户端（`client/`）

React + Vite 前端在开发模式下运行在操作系统分配的端口上（`port: 0`）。在桌面/生产模式下，Express 服务器直接从 `client/dist/` 提供构建好的静态文件。

| 面板 | 文件 | 职责 |
|---|---|---|
| 编辑器 | `EditorPane.tsx` | Monaco 编辑器，带标签页、文件树、SCM 面板、内置浏览器 webview 和终端标签页 — 主要工作区 |
| Agent 控制台 | `AgentConsole.tsx` | AI agent 的聊天界面。将用户目标发送到 `/api/chat/agent/stream`，消费 SSE 事件流，渲染工具调用并带动画/结果，在 `run_in_terminal` 时提示用户授权，并为文件编辑显示接受/拒绝差异对比 |
| 文件面板 | `FilesPanel.tsx` | 文件资源管理器树，支持创建/重命名/删除，右键上下文菜单和文件夹展开状态持久化 |
| 终端 | `TerminalPane.tsx` | xterm.js 终端标签页，通过 WebSocket 连接到服务器的终端管理器 |
| SCM 面板 | `ScmPanel.tsx` | Git 暂存区、提交历史、差异查看器 |
| 状态栏 | `StatusBar.tsx` | 语言选择器、编码、缩进、光标位置、跳转到行 |
| 菜单栏 | `MenuBar.tsx` | 文件/编辑/视图/终端/帮助菜单 |

客户端**永远不会直接调用 DeepSeek**。所有 AI 交互都通过服务器的 agent 循环进行，服务器持有 API Key 并执行工具。

### 数据流（Agent 回合）

```
用户输入目标 → AgentConsole
  → POST /api/chat/agent/stream (message, context, projectRoot)
     或 POST /api/chat/agent/stream/stepbystep (IDE 驱动模式)
  → 服务器构建动态系统提示 (ITR)，压缩历史，调用 DeepSeek
  → DeepSeek 通过 SSE 流返回文本/工具调用
  → 服务器直接执行文件系统工具（read_file、write_file 等）
  → 交互式浏览器工具（click、type 等）产生 SSE "browser_tool" 事件（仅子 agent）
  → AgentConsole 将浏览器命令发送到 EditorPane 的 webview
  → WebView 执行操作，返回结果
  → AgentConsole 调用 POST /api/chat/agent/stream/continue (toolCallId, result)
  → 循环持续直到 write_summary + task_complete
  → 成功的 write_summary 在 agent-body 中以 markdown 预览形式显示一次
```

### Agent 循环内部机制

Agent 循环（`agentLoopStream` / `agentLoop` 在 `server/agent.ts` 中）使用消息数组（`state.messages`）编排用户、模型和工具之间的对话。每个回合遵循固定模式：

```
┌──────────────────────────────────────────────────────────────┐
│  Agent 循环迭代                                               │
│                                                              │
│  1. buildOpenAiMessages(state)                               │
│     ↓ 将内部消息转换为 DeepSeek API 格式                      │
│     ↓ 将 tool_calls 与 tool_call_id 响应配对                  │
│     ↓ 注入系统提示（ITR 选择的片段）                          │
│                                                              │
│  2. chatDeepSeekToolStream(messages, tools)                  │
│     ↓ 发送到 DeepSeek，接收 SSE 流                            │
│     ↓ 产生思考事件、文本、工具调用                            │
│                                                              │
│  3. 对于每个工具调用：                                        │
│     ├─ 将 assistant 工具调用消息推入 state.messages           │
│     ├─ 执行工具（文件系统 / 终端 / 浏览器）                   │
│     ├─ 将工具结果消息推入 state.messages                      │
│     └─ 继续下一个工具（批量）或下一次迭代                      │
│                                                              │
│  4. 如果没有工具调用 → 最终文本回复（仅当没有执行工作时），否则必须 write_summary + task_complete │
│     → write_summary 存储最终摘要，AgentConsole 在 `agent-body` 中渲染一次，然后 `task_complete` 返回 phase: "done" │
└──────────────────────────────────────────────────────────────┘
```

#### 消息角色

Agent 状态跟踪三种消息角色，每种在对话中都有特定目的：

| 角色 | 创建者 | 目的 | 内容 |
|------|--------|------|------|
| **`user`** | 客户端（`createAgentSession`） | 用户的请求 / 目标 | 纯文本（"添加登录接口"） |
| **`assistant`** (文本) | DeepSeek API → 服务器推送 | 模型的推理 / 回复 | 文本响应 |
| **`assistant`** (带 `name`) | DeepSeek API → 服务器推送 | 工具调用请求 | JSON 数组 `{ id, function: { name, arguments } }` |
| **`tool`** | 服务器（工具执行后） | 工具执行结果 | 工具输出（文件内容、命令输出、浏览器结果） |

#### 消息生命周期

```
用户发送请求
  → state.messages = [{ role: "user", content: "..." }]

迭代 1：DeepSeek 决定读取文件
  → state.messages.push({ role: "assistant", name: "read_file", content: '[...]' })
  → 服务器执行 read_file → 返回文件内容
  → state.messages.push({ role: "tool", content: "...", tool_call_id: "call_1" })

迭代 2：DeepSeek 读取结果，决定编辑
  → state.messages.push({ role: "assistant", name: "edit_file", content: '[...]' })
  → state.messages.push({ role: "tool", content: "Wrote ...", tool_call_id: "call_2" })

迭代 3：DeepSeek 完成
  → 调用 write_summary → 存储最终结构化摘要
  → AgentConsole 将该摘要渲染一次作为 assistant 消息显示在 `agent-body` 中，
    使用 markdown 预览（`###` 标题、列表、行内代码）
  → 调用 task_complete → agent 使用存储的摘要返回 phase: "done"
```

每个工具调用始终是成对出现的：一条带 `name` 的 `assistant` 消息包含工具调用 JSON，紧接着一条带有相同 `tool_call_id` 的 `tool` 消息。`buildOpenAiMessages()` 强制执行此配对 — 未配对的工具调用会在请求到达 DeepSeek 之前获得合成的错误响应。

### 桌面模式 vs Web 模式

| 功能 | Web（浏览器） | 桌面（Electron） |
|---|---|---|
| 服务器 | 外部进程（`npm run dev:server`） | 通过 Electron 主进程中的 `tsx` require 嵌入 |
| 客户端 | Vite 开发服务器（OS 分配端口）或 Express 提供（生产模式） | 开发模式下用 Vite 开发服务器，生产模式下由 Express 提供 |
| 终端 | WebSocket 到服务器，管道回退 PTY | WebSocket 到服务器，Windows 上 `node-pty` 配合 ConPTY |
| 文件访问 | 浏览器 File System Access API 或服务器 FS API | 服务器 FS API + 原生 Electron `dialog` 用于文件夹/文件选择器 |
| 内置浏览器 | iframe + 反向代理（`/_browser`） | Electron `webview`，支持地理位置、权限、弹出窗口拦截 |

## 桌面版 (Electron)

Harness 也可以作为桌面应用运行（更接近 VS Code），带有嵌入式服务器和 PTY 支持的终端。

```powershell
# 桌面开发模式（运行 Vite + Electron）
npm run desktop:dev
```

```powershell
# 构建桌面打包用的客户端
npm run desktop:build

# 打包 Windows 构建（electron-builder）
npm run desktop:pack
```

注意事项：
- `npm install` 会自动运行 `electron-rebuild` 以支持 `node-pty`（通过 `postinstall`）。
- 终端优先使用 `node-pty`（Windows 上使用 ConPTY），并在 PTY 不可用时回退到管道模式。

## 内置浏览器（桌面版）

在 Electron 模式下，Harness 在编辑器区域包含一个完整浏览器，由 Electron `webview` 驱动。

### 功能

**自动检测 localhost URL** — 当终端进程输出 URL 时，Harness 实时扫描输出并在新的浏览器标签页中自动打开兼容的 URL。

- **检测模式：** 任何匹配 `http(s)://localhost`、`127.0.0.1`、`0.0.0.0` 或 `[::1]` 且带端口号的 URL（例如 `http://localhost:5173`）。
- **网页 vs API 过滤：** 在打开前，Harness 发送快速 `HEAD` 请求检查 `Content-Type` 头。只有返回 `text/html` 的 URL 才会作为浏览器标签页打开 — API 端点（例如 `/api/health`、JSON 响应）会被静默跳过。
- **去重：** 每个 URL 在每个终端会话中最多打开一次。终端输出中重复的相同 URL 会被忽略。
- **支持来源：** 同时支持 PTY 和管道终端，扫描 stdout 和 stderr。

**手动导航** — 在地址栏输入 URL 或 Bing 搜索查询，按 Enter 或点击前往。

**后退/前进/刷新** — 工具栏按钮，在导航不可用时显示禁用状态。

**站点信息** — 点击安全图标查看连接状态（安全/不安全）、当前 URL 和权限开关。

**站点权限** — 按来源的开关：
- **地理位置** — 使用 Windows 原生定位，通过 PowerShell `GeoCoordinateWatcher`（无需 Google API Key）。位置在 IDE 范围内缓存，每 5 分钟刷新一次。跨所有导航有效，无需重新授权。
- 摄像头 / 麦克风 / MIDI / 自动播放

**多标签浏览** — 可以同时打开多个浏览器标签页，就像文件标签页一样。

**标题同步** — 浏览器标签页标签跟随页面的 `<title>`。

**弹出窗口拦截** — 将打开新 Electron 窗口的链接捕获并改为打开新的 Harness 浏览器标签页。

**跨导航定位** — `navigator.geolocation` 在 `dom-ready` 时被覆盖，使页面始终使用 Harness 的原生 Windows 定位桥接，即使在不同路由之间导航也是如此。

> **注意：** 地理位置需要 `https://` 或 `localhost`。必须在 Windows 设置（`隐私 > 位置`）中启用 Windows 定位 API。

## 语言支持 (LSP)

Harness 通过两层提供编辑器智能功能 — 持续的错误/警告检查、补全和悬停提示：

**1. 内置（无需设置）：** Monaco 在浏览器中实时验证以下文件类型：

- JavaScript / TypeScript (JSX/TSX)
- JSON, CSS / SCSS / LESS, HTML

**2. 语言服务器 (LSP)：** 对于其他所有语言，Harness 通过 stdio 与标准语言服务器通信（`server/lsp.ts`）。架构遵循 VS Code 模型 — 基于推送，通过服务器推送事件 (SSE) 实现实时诊断。

### 架构（VS Code 风格的推送模型）

```
┌─ 客户端 (EditorPane.tsx) ─────────────────────────────────────┐
│                                                                │
│  用户在编辑器中输入                                              │
│       │                                                        │
│       ▼ (250ms 防抖)                                           │
│  POST /api/lsp/diagnostics  ─── 发后即忘的 didChange            │
│       │                                                        │
│       │                              ┌──────────────────┐     │
│       │   GET /api/lsp/watch ─── SSE │  每种语言一个     │     │
│       │   (持久连接)                  │  EventSource     │     │
│       │                              └──────┬───────────┘     │
│       │                                     │                  │
│       │    publishDiagnostics 事件 ◄────────┘                 │
│       ▼                                                        │
│  monaco.editor.setModelMarkers() ── 显示波浪线                  │
└────────────────────────────────────────────────────────────────┘
                               │
┌─ 服务端 (lsp.ts) ────────────▼────────────────────────────────┐
│                                                                │
│  notifyFileChange()                                            │
│       │                                                        │
│       ▼                                                        │
│  sendNotification("textDocument/didChange") ──► LSP 进程       │
│       │                                            │           │
│       │         textDocument/publishDiagnostics ◄──┘           │
│       ▼                                                        │
│  handleMessage() ── 广播到所有 SSE 客户端                       │
│       │                                                        │
│       ▼                                                        │
│  client.write("data: {uri, markers}\n\n") ──► SSE 流          │
└────────────────────────────────────────────────────────────────┘
```

**与基于轮询方法的主要区别：**

| 方面 | 旧方式（轮询） | 新方式（VS Code 风格） |
|---|---|---|
| 诊断传递 | 客户端每 250ms 轮询 `/api/lsp/diagnostics` | LSP 服务器通过 SSE 推送 — 即时 |
| 跨文件分析 | 仅轮询已更改的文件 | 任何更改都会收到所有文件的诊断 |
| URI 处理 | 轮询使用模块级 Map，手动规范化 key | SSE 流将规范化 URI 直接流式传输到匹配文件 |
| 连接 | 每次文件变更一个 HTTP 请求 | 每种语言一个持久 SSE 连接 |

**工作原理：**

1. **SSE 连接** — 当文件打开时，客户端为每种语言建立一个持久的 `GET /api/lsp/watch?rootPath=...&language=...` SSE 连接。服务器保持连接打开并将其注册在 `session.sseClients` 中。

2. **文件变更通知** — 当内容变更时（250ms 防抖），客户端发送 `POST /api/lsp/diagnostics` 并附带文件文本。服务器向 LSP 进程发送 `textDocument/didOpen` 或 `textDocument/didChange` 并立即返回（发后即忘）。

3. **诊断推送** — 当 LSP 服务器发出 `textDocument/publishDiagnostics` 时，`handleMessage()` 将标记广播到该语言的所有已连接 SSE 客户端。客户端接收事件，将 URI 匹配到打开的文件，并调用 `monaco.editor.setModelMarkers()` 渲染波浪线。

4. **跨文件分析** — 因为 pyright（和其他 LSP 服务器）在任何更改时扫描整个工作区，所有文件的诊断通过 SSE 到达并同时应用。打开 file2 会立即显示 pyright 在 file1 分析期间发布的错误。

语言服务器仅在其可执行文件在 `PATH` 上可用时才被使用。如果未安装，该语言将被直接跳过 — 没有错误，无需设置。

### URI 规范化

不同的 LSP 服务器以不同方式编码文件 URI — pyright 使用 `%3A` 表示盘符，`%5C` 表示反斜杠，pylsp 使用裸字符，有些会双重编码。`server/lsp.ts` 中的 `normalizeUri()` 函数处理所有变体：

- 渐进式 `decodeURIComponent`（处理双重编码如 `%2520`）
- 对混合原始/编码 URI 进行逐字符回退
- 反斜杠 → 正斜杠规范化
- 大小写不敏感匹配（小写）

### 支持的语言及其服务器

| 语言 | 服务器二进制文件 | 安装（示例） |
| --------------- | ------------------------------ | ------------------------------------------------------ |
| Python | `pyright-langserver`（首选）<br>`pylsp`（回退） | `npm i -g pyright`<br>`pip install python-lsp-server pyflakes` |
| JavaScript / TS | *(Monaco 内置)* | — |
| HTML / CSS / JSON | *(Monaco 内置)* | — |
| Java | `jdtls` | 安装 Eclipse JDT Language Server |
| C# | `omnisharp` | 安装 OmniSharp (`-lsp`) |
| C / C++ | `clangd` | 安装 LLVM/clangd |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Ruby | `solargraph` | `gem install solargraph` |
| PHP | `intelephense` | `npm i -g intelephense` |
| Swift | `sourcekit-lsp` | 随 Swift 工具链附带 |
| Kotlin | `kotlin-language-server` | 安装 kotlin-language-server |
| Markdown | `marksman` | 安装 marksman |
| YAML | `yaml-language-server` | `npm i -g yaml-language-server` |
| SQL | `sqls` | `go install github.com/lighttiger2505/sqls@latest` |

> 还开箱即用地支持更多服务器（Lua、Dockerfile、Vue、Svelte、Dart、Elixir、Haskell、Terraform、Clojure、OCaml、Zig、Scala、TOML、Bash）— 安装对应的二进制文件并重新加载即可。

安装服务器后，**重启后端**（`npm run dev:server`，或 `npm run dev`）以检测到新的可执行文件。

### 减少误报

Harness 应用多层过滤以保持诊断的高信噪比：

**服务端诊断管道**（`lsp.ts` — `handleMessage`）：
- **严重级别过滤** — 信息 (3) 和提示 (4) 级诊断被丢弃。只有错误和警告会到达编辑器。
- **有效性检查** — 具有负行/列位置或反向范围（结束在开始之前）的诊断被丢弃。
- **每文件上限** — 每文件最多 200 条诊断，防止在遗留或无类型代码上 UI 泛滥。

**按语言 LSP 服务器调优**（在初始化时通过 `workspace/didChangeConfiguration` 应用）：

| 语言 / 服务器 | 调优 |
|---|---|
| **JavaScript** (Monaco 内置) | 仅语法验证；禁用语义/类型检查（纯 JS 中没有模块图） |
| **TypeScript** (Monaco 内置) | 完整的语义检查，`strict: false`，`noImplicitAny: false` |
| **Python / pyright** | `typeCheckingMode: "basic"`，`diagnosticMode: "openFilesOnly"`；<br>`reportOptional*` 规则 → `"none"`（惯用 Python 使用 Optional 不加守卫）；<br>`reportMissingImports` → `"warning"`（venv/单体仓库路径解析缺失）；<br>`reportAttributeAccessIssue`、`reportArgumentType`、`reportAssignmentType` → `"warning"` |
| **Python / pyright** (venv) | 自动检测项目根下的 `.venv` / `venv` / `env` / `.env`，并传递 `venvPath` + `venv` 使 pyright 解析 site-packages |
| **Python / pylsp** | 保留 `pyflakes`（真实的 bug）；禁用 `pycodestyle`、`pydocstyle`、`mccabe`、`flake8`、`pylint` |
| **YAML** | 禁用 schema-store 查询 — 避免在无匹配 schema 时出现"Schema not found"误报 |
| **Go / gopls** | `staticcheck: false` — 禁用带有主观倾向的风格建议 |

**引擎级别修复：**
- `mapSeverity` 将未定义的严重级别默认设为**错误**（LSP 规范：省略表示错误），而非警告。
- 诊断缓存按项目根作用域划分 — SSE 初始化仅刷新当前会话的 URI，而非全局映射。
- 当 LSP 会话退出时，诊断条目从缓存中清理，防止残留标记。

### 添加语言

在 `server/lsp.ts` 的 `SERVER_SPECS` 中添加一个条目，将语言 ID 映射到其服务器二进制文件，并（如果需要）在 `client/src/panes/fileModel.ts` 的 `detectLanguage` 中添加文件扩展名。

## 文件管理

Harness 包含一个文件资源管理器树（`FilesPanel`），具有完整的创建、删除和重命名功能 — 既可供你手动使用，也可供 AI agent 使用。

**创建文件**
- 点击文件头部的 **+** 按钮创建新文件。如果树中没有选中文件夹，文件将在项目根目录中创建。如果选中了一个文件夹（点击一次 — 会高亮显示），新文件将创建在该文件夹内。
- 当你在尚不存在的路径下添加文件时，文件夹将按需自动创建。

**右键上下文菜单**
- 在文件树中右键点击任意项目以**重命名**或**删除**它。
- 删除文件夹会递归删除其内容。

**AI Agent 文件访问**
AI agent 具有以下文件系统工具：

| 工具 | 描述 |
|------|------|
| `read_file` | 带行号读取文件（或列出目录） |
| `write_file` | 创建或覆盖文件的完整内容 |
| `edit_file` | 精确的字符串替换 — 仅发送变更的行 |
| `list_files` | 列出目录内容（跳过 `.git` / `node_modules`） |
| `search_files` | 按名称模式递归查找文件/文件夹 |
| `grep` | 按正则表达式模式搜索文件内容 |
| `create_directory` | 创建新目录（及任何父目录） |
| `rename_file` | 重命名或移动文件或目录 |
| `delete_file` | 删除文件或目录（递归） |

所有工具都相对于项目根目录操作。Agent 可以自行浏览、创建、编辑和清理文件 — 无需手动干预。

**服务端 API**
| 端点 | 方法 | 描述 |
|----------|--------|------|
| `/api/fs/create-file` | POST | 创建文件（及父目录）（如果尚不存在） |
| `/api/fs/delete` | DELETE | 删除文件或目录（目录递归删除） |
| `/api/fs/rename` | POST | 重命名/移动文件或目录 |
| `/api/fs/read-binary` | GET | 以二进制形式读取文件（供 `browser_upload_file` 使用） |

## 智能文件追踪

Harness 使用动态文件追踪系统，自动检测 Git 可用性 — 遵循现代 IDE 使用的"工作区信任"模式。

### 工作原理

```
┌─ 启动 / 打开文件夹 ──────────────────────────────────────────────┐
│                                                                    │
│  checkGitAvailable() → git --version                               │
│       │                                                            │
│       ├── Git 存在 ──► Git 模式                                    │
│       │   使用 git status/diff 进行文件变更追踪                     │
│       │   完整的 SCM 支持（分支、提交、推送/拉取）                   │
│       │                                                            │
│       └── 无 Git ────► 监视器模式                                   │
│           使用 fs.watch（Node 内置 API）监视变更                    │
│           元数据缓存存储在 ~/.harness/store/file-tracking.json      │
│           无需依赖                                                  │
│                                                                    │
│  → 状态栏在初始化期间显示旋转器 + "扫描中..."                        │
│  → 文件树快照即刻构建（在首次 agent 运行之前就绪）                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
┌─ 会话中期安装 Git ─────────────────────────────────────────────────┐
│                                                                    │
│  定期检查（每 30 秒）检测到 git --version 返回成功                  │
│       │                                                            │
│       ▼                                                            │
│  前端显示对话框："检测到 Git！切换到 Git 追踪模式？"                 │
│       │                                                            │
│       ├── 确认 → switchToGit()                                     │
│       │   • 停止文件监视器                                         │
│       │   • git init（如果没有仓库）                                │
│       │   • 比较缓存状态与文件系统                                  │
│       │   • 如果需要则自动提交                                      │
│       │   • 清理监视器缓存                                          │
│       │                                                            │
│       └── 暂不 → 保持监视器模式                                     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 追踪模式

| 模式 | 检测 | 文件变更 | SCM 面板 | 状态栏 |
|------|------|----------|----------|--------|
| **git** | 启动时或切换时检测到 Git | `git status --porcelain` | 完整功能 | 分支图标 + "main" |
| **watcher** | 无 Git 可用 | `fs.watch` 递归 + JSON 缓存 | 禁用 | 十字准星图标 + "Watcher" |
| **loading** | 刚打开文件夹 | 扫描文件系统 + 构建快照 | — | 旋转器 + "扫描中..." |
| **none** | 没有打开文件夹 | — | — | — |

### AI Agent 的文件树上下文

当 agent 运行时，Harness 将项目文件树作为系统提示上下文的一部分发送。快照在打开文件夹时**即刻构建**（不推迟到首次 agent 调用时），因此始终就绪。

```
┌─ 打开文件夹 ────────────────────────────────────────────────────────┐
│  → buildSnapshot() 遍历整个项目（跳过 node_modules/.git）           │
│  → 构建知识图谱 (~/.harness/snapshots/file-tree-snapshot-<hash>.kg)  │
│  → 可视化写入 ~/.harness/snapshots/file-tree-snapshot-<hash>.txt    │
│  → 状态栏：遍历期间显示旋转器 + "扫描中..."                         │
└────────────────────────────────────────────────────────────────────┘
                              │
┌─ 首次 agent 运行 ──────────────────────────────────────────────────┐
│  → "(无上次更新以来的文件树变更)" — 快照匹配                        │
└────────────────────────────────────────────────────────────────────┘
                              │
┌─ 后续 agent 运行（同一文件夹）─────────────────────────────────────┐
│  → 仅发送补丁："+ 新增文件" / "- 已删除文件"                        │
│  → 每次发送后更新快照                                              │
└────────────────────────────────────────────────────────────────────┘
                              │
┌─ 大量变更（>100 个文件不同）────────────────────────────────────────┐
│  → 例如 git checkout 到不同分支后                                   │
│  → 回退到发送完整树而不是大量补丁                                   │
│  → 快照更新，后续调用恢复正常补丁模式                                │
└────────────────────────────────────────────────────────────────────┘
                              │
┌─ 跨会话连续性 ─────────────────────────────────────────────────────┐
│  → 快照持久化到磁盘                                                │
│  → 重启 IDE 不会重新发送完整树，除非文件夹变更                      │
│  → 打开新文件夹 → 快照重建 → 在首次运行前就绪                       │
└────────────────────────────────────────────────────────────────────┘
```

### 工作区去重

每个工作区获得一个唯一的快照文件名，由其解析后绝对路径的 MD5 哈希值作为键。这防止了跨项目冲突，并确保同一文件夹始终映射到同一图谱文件。

```
d:\Work Projects\Harness   → MD5 → a1b2c3d4e5f6
                             → ~/.harness/snapshots/file-tree-snapshot-a1b2c3d4e5f6.kg
                             → ~/.harness/snapshots/file-tree-snapshot-a1b2c3d4e5f6.txt

d:\Other Projects\app       → MD5 → f6e5d4c3b2a1
                             → ~/.harness/snapshots/file-tree-snapshot-f6e5d4c3b2a1.kg
                             → ~/.harness/snapshots/file-tree-snapshot-f6e5d4c3b2a1.txt
```

- **同一文件夹，同一哈希** — 重新打开项目会覆盖其现有快照（无过期重复）。
- **不同文件夹，不同哈希** — 每个工作区有独立的图谱文件。
- **路径变更会断开链接** — 重命名或移动项目文件夹会产生新哈希和新快照。旧文件会成为孤立文件（不会自动清理）。
- **`read_graph` 使用相同的哈希方式** — 工具在查询时通过计算相同的 MD5 来定位正确的 `.kg` 文件。

### API 端点

| 端点 | 方法 | 描述 |
|----------|--------|------|
| `/api/file-tracking/status` | GET | 当前追踪模式、Git 可用性、工作区路径 |
| `/api/file-tracking/init` | POST | 初始化工作区追踪（`{ workspacePath }`） |
| `/api/file-tracking/git-detected` | GET | 前端轮询 — 会话中期检测到 Git 时返回 `{ gitDetected: true }` |
| `/api/file-tracking/switch-to-git` | POST | 从监视器切换到 git；自动初始化仓库，比较状态 |
| `/api/file-tracking/changes` | GET | 获取变更文件（两种模式均可工作） |
| `/api/file-tracking/refresh` | POST | 强制在监视器模式下重新扫描工作区 |
| `/api/file-tracking/file-tree-context` | GET | 首次调用返回完整树，后续调用返回补丁，供 agent 系统提示使用 |
| `/api/file-tracking/reset-snapshot` | POST | 重置快照，使下次上下文调用返回完整树 |

### 文件

| 文件 | 职责 |
|------|------|
| `server/fileTracking.ts` | `FileTrackingService` — 单例，编排 Git 或监视器模式、定期 Git 检测、快照/补丁逻辑 |
| `server/fileTrackingStore.ts` | `FileTrackingStore` — 轻量级 JSON 缓存（`~/.harness/store/file-tracking.json`）用于文件元数据 |
| `server/knowledgeGraph.ts` | `buildKnowledgeGraph()` — 构建代码库图谱，包含 CONTAINS + IMPORTS 边、`.kg` 序列化、`.txt` 可视化 |
| `~/.harness/store/file-tracking.json` | 监视器模式的磁盘元数据缓存 |
| `~/.harness/snapshots/file-tree-snapshot-<hash>.kg` | 每工作区知识图谱 — 节点（目录/文件）+ CONTAINS 边 + 解析的 IMPORTS |
| `~/.harness/snapshots/file-tree-snapshot-<hash>.txt` | 人类可读的可视化副文件（带导入注释的嵌套树） |

## 知识图谱

Harness 在打开文件夹时构建**代码库知识图谱** — 这是每个文件、目录、导出符号及其关系的结构化表示。它作为紧凑的嵌套树提供给 agent 的系统提示，并持久化到磁盘作为 `.kg` 文件用于基于图谱的查询。

### Schema

图谱有三种节点类型和四种边类型：

| 节点类型 | 字段 | 描述 |
|-----------|-------|------|
| `dir` | `name` | 目录 |
| `file` | `name`、`kind`（扩展名） | 源文件、配置、文档 |
| `symbol` | `name`、`kind` | 导出函数、类、const、类型、接口、枚举或默认导出 |

| 边类型 | 从 → 到 | 描述 |
|-----------|-----------|------|
| `CONTAINS` | dir → file \| dir | 结构关系：父目录包含子项 |
| `EXPORTS` | file → symbol | 文件导出命名符号 |
| `IMPORTS` | file → file | 文件级导入（例如 `import './utils'`） |
| `IMPORTS_SYMBOL` | file → symbol | 精确的符号级导入（例如 `import { foo } from './utils'`） |

### 符号解析

对于 TypeScript/JavaScript 文件（`.ts`、`.tsx`、`.mts`、`.cts`），TypeScript 编译器 API 解析 AST 以提取导出：

| 类型 | 从…检测 |
|------|----------|
| `function` | `export function foo()` |
| `class` | `export class Foo {}` |
| `const` | `export const x = ...`、`export { x }` |
| `type` | `export type T = ...` |
| `interface` | `export interface I {}` |
| `enum` | `export enum E {}` |
| `default` | `export default function/class/expr` |

命名导入（`import { foo, bar } from './module'`）被匹配到目标文件导出，以创建精确的 `IMPORTS_SYMBOL` 边 — 因此图谱确切地知道*哪个符号*依赖于*哪个符号*，而不仅仅是哪些文件。

### .kg 格式（磁盘上）

紧凑的边列表格式，位于 `~/.harness/snapshots/file-tree-snapshot-<hash>.kg`：

```
# Knowledge Graph v2 — D:\Work Projects\Harness
# Nodes: 384  Edges: 512
# Format: n<id>|<type>|<parentId>||<name>|<kind>
#   type: dir|file|symbol

n0|dir|||Harness|
n1|file|n0||README.md|md
n2|dir|n0||server|
n3|file|n2||index.ts|ts
n4|symbol|n3||app|const
n5|file|n2||fileTracking.ts|ts
n6|symbol|n5||getFileTrackingService|function
n7|symbol|n5||FileTrackingService|class

e0|n0|n1|CONTAINS
e47|n5|n6|EXPORTS
e72|n3|n6|IMPORTS_SYMBOL
```

每行都是自包含的 — 用 `split("|")` 解析，通过遍历父链重建路径。没有 JSON 开销，可以使用基于行的工具轻松进行 diff。

### .txt 可视化（人类可读）

带导出/导入注释的嵌套树，与 `.kg` 文件并列写入：

```
Harness {
  server {
    index.ts  (exports: app:const; → getFileTrackingService, FileTrackingService)
    fileTracking.ts  (exports: getFileTrackingService:function, FileTrackingService:class, ...)
    knowledgeGraph.ts  (exports: buildKnowledgeGraph:function, KnowledgeGraph:interface, ...)
  }
  client {
    src {
      App.tsx  (→ EditorPane)
      panes {
        EditorPane.tsx  (exports: EditorPaneHandle:interface; → FilesPanel, fileModel)
      }
    }
  }
}
# 124 exports
# 47 file-level imports
# 89 symbol-level imports
```

### 过滤

图谱排除密钥文件（`.env`）、VCS 内部文件（`.git/`）、依赖（`node_modules/`、`vendor/`）、构建输出（`dist/`、`.next/`）、IDE 缓存、二进制/媒体文件和锁文件。项目配置点文件（`.eslintrc.js`、`.prettierrc`、`.editorconfig`）和点目录（`.github/`、`.husky/`、`.storybook/`、`.vscode/`）被包含在内。

### 基于图谱的推理基础

知识图谱旨在作为图机器学习和路径预测的输入：

- **单跳查询**："哪个文件导出 `getFileTrackingService`？" — 反向跟踪 `EXPORTS`。
- **调用图遍历**：`IMPORTS_SYMBOL` 边形成精确的依赖图 — 跟踪它们以理解数据流。
- **PageRank**：被许多其他文件导入的文件具有更高的中心性 — 识别核心模块。
- **马尔可夫链路径预测**：`IMPORTS_SYMBOL` 边上的转移概率回答"如果你刚刚编辑了符号 X，接下来最可能需要更改哪个文件？"
- **GNN 输入**：节点携带特征 `(type, kind, name)`，边携带 `(type)`。可以直接从 `.kg` 文件构建邻接矩阵，用于训练图神经网络分析代码库结构。

### 与 Graphify 的比较

Harness 和 [Graphify](https://github.com/Graphify-Labs/graphify) 共享相同的核心思想：预构建知识图谱，使 AI agent 能够通过单次查询回答结构性问题，而不是扫描原始文件。区别在于范围和设计理念：

| | Harness | Graphify |
|---|---|---|
| **触发方式** | 始终开启的内置 IDE 功能 | 手动调用的 CLI 技能 (`/graphify`) |
| **AST 解析** | TypeScript 编译器 API (TS/JS) | Tree-sitter（23 种语言） |
| **LLM 参与** | 零 — 完全确定性 | 两阶段：确定性 AST + Claude 子 agent 进行语义/概念提取 |
| **输出格式** | 紧凑的 `.kg` 边列表（Token 优化）+ `.txt` 可视化 | `.graph.html`（交互式）、`.graph.json`（NetworkX）、`GRAPH_REPORT.md` |
| **多模态** | 仅代码文件 | 代码、PDF、图像、视频、音频、图表 |
| **社区检测** | 无 | Leiden 聚类 — 按边密度分组子系统 |
| **置信度标记** | 不适用（一切都是 EXTRACTED） | EXTRACTED / INFERRED / AMBIGUOUS |
| **查询接口** | `read_graph` 工具 — 5 种查询类型（structure、exports、imports_of、exporters_of、dependents） | Python NetworkX API + CLI |
| **更新模型** | 文件监视器事件触发自动重建（2s 防抖） | SHA256 缓存 — 仅重新运行变更的文件 |
| **Agent 集成** | 系统提示规则 + 工具注册表 | CLAUDE.md/AGENTS.md 规则 + PreToolUse 钩子（在 grep/glob 之前触发） |
| **足迹** | 轻量级，极小的 Token 开销 — 始终就绪 | 更重但更丰富 — HTML 可视化、自然语言报告、多格式 |

Harness 优先考虑**零延迟、始终可用的图谱可用性**，嵌入在 IDE 循环中，并采用专为 LLM Token 效率而构建的紧凑格式。Graphify 优先考虑**深度和广度** — 多语言、多格式、语义推理 — 以设置时间为代价换取了更丰富的架构洞察。

## 安全

Harness 向 AI agent 授予对文件系统、终端和浏览器的访问权限。以下缓解措施可防范供应链风险（受感染的 API 响应、模型提示注入或恶意工具输出）。

### API 与传输

- 所有 DeepSeek API 调用使用 **HTTPS**（`https://api.deepseek.com/v1`）。
- 客户端输入的 DeepSeek API Key 持久化存储在磁盘 `~/.harness/store/api-keys.enc`（AES-256-GCM 加密），由 HTTP-only 会话 cookie 作为密钥。Key 永远不会写入浏览器的 `localStorage`。
- Agent 请求和 `/api/models` 在初始凭据提交后不再在请求体或查询字符串中包含原始 Key。
- API Key 永远不会暴露给子进程（参见下方终端沙箱）。
- `/api/chat/agent/config` 仅暴露配置状态（`apiKeyConfigured`、`source`），而不是 Key 值本身。
- `/api/chat/agent/credentials` 是唯一接受原始客户端输入 Key 的路由，并且它将该 Key 以文件支持的持久化方式存储在服务器端（在服务器重启和应用更新后仍然存在）。

### 工具级防护

| 工具 | 防护措施 | 阻止 |
|------|----------|------|
| `browser_navigate` | **URL 验证** | `javascript:`、`data:`、`file:` 协议。仅允许 `http://` 和 `https://`。 |
| `run_command` | **环境变量清理** | 任何名称包含 `KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`CREDENTIAL` 或以 `npm_` 开头的环境变量在子进程启动前被剥离。仅转发 `PATH`、`HOME`、`USER`、`TEMP`、`SHELL`、`SYSTEMROOT`、`LANG`。 |
| `run_in_terminal` | **用户授权** + **命令清理** | 用户必须在每个命令运行前显式允许。在 Windows 上，bash 语法（`2>&1`、`&&`）被自动更正为 PowerShell 等效语法。 |
| `read_file` / `grep` / `list_files` / `write_file` / `edit_file` / `delete_file` / `rename_file` / `search_files` | **密钥文件拦截** | 所有文件系统工具拒绝访问匹配 `.env`、`.env.*`、`credentials.*`、`secret.*`、`.pem`、`.key`、`.p12`、`.pfx` 以及 `config/*secret*` / `config/*key*` 路径的文件。这些文件也会从目录列表和搜索结果中隐藏。 |

### 浏览器沙箱

- **iframe** 使用 `allow-scripts allow-same-origin allow-forms allow-popups` 进行沙箱化。阻止：顶级导航（不能跳出框架）、插件、模态框、指针锁定、下载。
- **内容安全策略** 头被注入到所有代理页面：`default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'self'; form-action *`。这阻止了代理站点向 Harness 自己的 API 端点发起 `fetch()` 调用。
- 原始站点的 `X-Frame-Options` 和 `Content-Security-Policy` 头被剥离以允许框架化，但注入的 CSP 替换了它们。

### 人机协作

| 触发条件 | 机制 |
|----------|------|
| `run_in_terminal` | Agent 控制台中的允许/拒绝提示 |
| `write_file` / `delete_file` | Agent 控制台中的接受/拒绝撤消卡片 |

### 局限性

- **设计上仍然信任 DeepSeek 的 API 响应。** 如果模型提供商的基础设施被入侵并注入恶意工具调用，工具级防护（URL 验证、eval 阻止、环境变量清理）将捕获最危险的攻击类别，但不是全部。在处理不受信任的项目时，请在隔离环境（VM、开发容器）中运行 Harness。
- **`run_command` 未进行容器沙箱化。** 它使用经过清理环境的 `child_process.spawn`。要实现完全隔离，请在 Docker 或 VM 内运行 Harness。
- 文件写入可通过 UI 撤消，但 agent 对项目目录具有完全的写入权限。

## Agent 工具（DeepSeek 驱动）

AI agent 在项目工作中可以访问以下工具：

### 文件系统

| 工具 | 描述 |
|------|------|
| `read_file` | 带行号读取文件 — 在编辑前始终先读取 |
| `write_file` | 创建或覆盖文件完整内容（需要用户接受/拒绝） |
| `edit_file` | 通过用 new_string 替换 old_string 进行精确编辑。成本更低 — 仅发送变更的行。old_string 必须精确匹配，包括空格/缩进。使用 replace_all 替换所有匹配项。 |
| `list_files` | 列出给定路径中的文件和目录 |
| `search_files` | 按名称模式递归查找文件/文件夹（大小写不敏感） |
| `grep` | 按正则表达式模式搜索文件内容 — 查找定义、用法 |
| `create_directory` | 创建目录（及父目录） |
| `rename_file` | 重命名或移动文件或目录 |
| `delete_file` | 递归删除文件或目录 |

### 终端

| 工具 | 类型 | 描述 |
|------|------|------|
| `run_command` | **沙箱** | 运行 shell 命令，获取内联输出。快速，无需授权。用于：测试、lint、git、pip、npm、构建、grep。输出被汇总为关键行（错误、警告、URL）；完整输出被缓存供 `read_command_output` 使用。 |
| `run_in_terminal` | **真实终端** | 在专用终端标签页中运行长时间命令。用户必须允许每个命令。用于：`python app.py`、`npm start`、flask、监视模式、交互式 shell。Agent **等待命令退出或产生可识别的输出**（traceback、服务器启动消息等），然后接收结果。终端输出完整捕获到 UI 工具卡片中，汇总版（关键错误/成功行）发送给模型以节省 Token。 |
| `kill_terminal` | **控制** | 终止 agent 生成的终端会话。**`kill_terminal`** 终止所有，**`kill_terminal index=N`** 终止第 N 个终端（从 0 开始，按创建顺序）。仅终止 agent 启动的终端 — 用户创建的终端不受影响。返回确认消息，说明哪个终端被终止及其命令。用于停止服务器、释放端口或在完成前清理。 |

#### `run_in_terminal` 生命周期

```
Agent 调用 run_in_terminal
  → 命令清理（Windows：移除 2>&1，&& → ;）
  → 用户允许/拒绝提示
  → 命令在终端标签页中运行
  → Agent 等待：
       - 进程退出 (onFinish)
       - 服务器启动模式（例如 "listening on :3000"）
       - 检测到错误（traceback、ModuleNotFoundError、npm ERR! 等）→ 500ms 刷新延迟
       - 120 秒超时回退
  → 完整终端输出发送到 UI 工具卡片
  → 汇总输出（关键行，最多 8 行 / 1200 字符）推送到模型上下文
  → 完整输出缓存在 commandOutputStore 中，供 read_command_output 使用，键为 [cmd #N]
  → Agent 读取结果并处理错误或继续到浏览器
```

**Windows/PowerShell 兼容性：** 在 Windows 上，终端运行 PowerShell。会自动纠正会静默失败的 Bash 写法：

| Bash 语法 | 问题 | 自动修正 |
|------------|------|----------|
| `2>&1` | PowerShell 不理解 stderr 重定向；会导致解析错误 | 移除（PowerShell 原生捕获 stderr） |
| `&&`（成功后链接） | PowerShell 使用 `;` 进行命令链接 | 转换为 `;` |

**长篇日志的输出处理：** 如果终端输出数千行（例如冗长的应用启动），只有汇总视图会到达模型 — 来自完整输出的错误行、警告和成功标记，限制为 8 行 / 1200 字符。完整输出始终可通过 `read_command_output cmd_id=N` 获取，并支持分页（`offset`、`limit`）和正则过滤（`filter`）。

### 浏览器

| 工具 | 作用域 | 描述 |
|------|-------|------|
| **导航** |||
| `browser_navigate` | 仅子 agent | 导航到 URL（仅 http/https）。如果不存在浏览器标签页则创建新标签页，否则导航活动标签页。在返回前等待浏览器视图挂载（最多 2 秒）。 |
| `browser_info` | 仅子 agent | 获取当前浏览器标签页状态：URL、页面标题、加载状态和打开的标签页数量。 |
| **观察**（只读） |||
| `browser_screenshot` | 仅子 agent | 获取页面概览：URL、标题和标准化的位置稳定网格（`V:WxH`、`XX\|N` 分段头、`NN\|tag#id[type] "label" FLAGS x,y:WxH ^ctx` 每行）。上限为 500 个元素、80K 字符。在密集页面（>400 个展示元素）上，网格自动分割为水平区域（`Band 1/3 y:0-600` 等），以便 agent 一次处理一个区域。包含可见错误文本。 |
| `browser_get_dom` | 仅子 agent | 获取标准化的位置稳定网格格式的完整索引 DOM。与 `browser_screenshot` 相同的严格字段格式。上限为 3,000 个元素、120K 字符。在密集页面上，自动分割为水平区域（>400 时为 2，>800 时为 3，>1,200 时为 4），跨区域使用全局索引，以便点击/输入引用保持正确。索引按从上到下、从左到右排序（纯几何）。标志：`A`=可点击、`A+`=可交互、`disabled`、`checked`、`readonly`、`required`。折叠/隐藏/被遮挡的元素被过滤掉。 |
| `browser_console` | 仅子 agent | 获取最后 50 条控制台条目（日志、警告、错误、对话框）以检查 JS 错误 |
| `browser_request_errors` | 仅子 agent | 获取失败的网络请求（4xx/5xx/CORS）以验证 API 调用和资源加载 |
| **交互**（仅子 agent） |||
| `browser_click` | **仅子 agent** | 按 DOM 索引或像素坐标点击。分发完整的指针/鼠标事件序列。 |
| `browser_type` | **仅子 agent** | 按 DOM 索引向输入框输入文本 — 先点击，清除，然后用逼真的键盘事件输入 |
| `browser_clear` | **仅子 agent** | 按 DOM 索引清除输入元素的值 |
| `browser_select` | **仅子 agent** | 按值或标签从 `<select>` 下拉菜单中选择选项 |
| `browser_scroll` | **仅子 agent** | 按像素或滚动到页面顶部/底部 |
| `browser_press_key` | **仅子 agent** | 在活动元素上按下键盘按键（Enter、Escape、Tab、方向键等） |
| `browser_wait` | **仅子 agent** | 等待匹配 CSS 选择器的元素出现（每 200ms 轮询，默认 5 秒超时） |
| **鼠标 / 文件上传** |||
| `browser_move_mouse` | **仅子 agent** | 将光标移动到 x,y — 触发悬停效果而不点击 |
| `browser_right_click` | **仅子 agent** | 在 x,y 处右键点击 — 分发 contextmenu 事件 |
| `browser_upload_file` | **仅子 agent** | 通过绝对路径设置文件输入的文件 |

### 诊断

| 工具 | 描述 |
|------|------|
| `read_problems` | 读取当前 IDE 诊断 — linter 错误、TypeScript 错误、警告、提示、调试控制台、输出、浏览器控制台。在进行更改后调用以验证没有新错误。 |
| `read_graph` | 查询代码库知识图谱以获取结构/依赖信息 — 文件导出了什么、谁从文件导入、哪些文件导出给定符号、完整目录树。对于依赖问题，比 grep 快得多。 |

#### `read_graph` — 知识图谱查询

`read_graph` 查询代码库知识图谱（Schema 详情参见[知识图谱](#知识图谱)）。它从 `~/.harness/snapshots/` 读取 `.kg` 文件并在不扫描文件内容的情况下回答结构性问题。用于依赖分析、符号发现和项目结构探索。

##### 查询类型

| 查询 | 格式 | 描述 | 示例 |
|-------|------|------|------|
| **导出** | `exports <file>` | 列出文件导出的所有符号 | `exports server/fileTracking.ts` |
| **导入来源** | `imports_of <file>` | 列出文件导入的所有符号和文件 | `imports_of client/src/App.tsx` |
| **导出者** | `exporters_of <symbol>` | 查找哪些文件导出此名称的符号 | `exporters_of getFileTrackingService` |
| **被依赖者** | `dependents <file>` | 查找哪些文件从此文件导入（反向依赖） | `dependents server/fileTracking.ts` |
| **结构** | `structure` | 打印完整目录树（目录 + 文件，无符号） | `structure` |

##### 查询详情

**`exports <file>`** — 返回每个导出符号及其类型：
```
server/fileTracking.ts exports:
FileTrackingService:class
getFileTrackingService:function
TrackingMode:type
```

**`imports_of <file>`** — 返回符号级和文件级导入：
```
client/src/App.tsx imports:
Symbol-level imports:
  EditorPane from client/src/panes/EditorPane.tsx
  StatusBar from client/src/panes/StatusBar.tsx
File-level imports (3):
  client/src/App.css
  client/src/index.css
  client/src/vite-env.d.ts
```

**`exporters_of <symbol>`** — 大小写不敏感符号搜索。当你知道函数名但不知道其位置时很有用：
```
Files exporting 'getFileTrackingService':
server/fileTracking.ts → getFileTrackingService:function
server/index.ts → getFileTrackingService:function
```

**`dependents <file>`** — 反向依赖查找。显示哪些文件从目标导入，包括通过导出符号的间接依赖者：
```
server/fileTracking.ts is imported by:
client/src/App.tsx
client/src/panes/StatusBar.tsx
server/agent.ts
server/index.ts
```

**`structure`** — 完整目录树用于定位。返回排序的路径 — 无嵌套，每行一个路径，以提高 Token 效率：
```
Directory tree (384 entries):
Harness
Harness/.eslintrc.js
Harness/client
Harness/client/index.html
Harness/client/package.json
...
```

##### 何时使用 `read_graph` vs `read_file` vs `grep`

| 问题 | 使用 | 原因 |
|----------|------|------|
| "`fileTracking.ts` 导出了什么？" | `read_graph exports` | 直接查找 — 无需扫描文件 |
| "`fileTracking.ts` 的内容是什么？" | `read_file` | 内容，而非结构 |
| "`initFileTracking` 在哪里被调用？" | `grep` | 跨文件内容搜索 |
| "谁从 `fileTracking.ts` 导入？" | `read_graph dependents` | 反向依赖 — 仅用 grep 无法实现 |
| "哪些文件导出名为 `foo` 的函数？" | `read_graph exporters_of` | 符号级查询 — grep 会匹配注释、字符串、调用 |
| "在 `server/` 中查找所有 `.ts` 文件" | `list_files` 或 `search_files` | 文件/目录列表 |
| "这个项目是什么样的？" | `read_graph structure` | 一次调用获取完整树 |

**关键原则：** `read_graph` 回答结构性问题（存在什么、如何连接）。`read_file` 和 `grep` 回答内容问题（里面有什么、在哪里使用）。不确定时，对于依赖/导出查询优先使用 `read_graph` — 这是一次调用，而不是潜在的数十次 grep 搜索。

### 控制

| 工具 | 描述 |
|------|------|
| `write_todos` | 创建或更新结构化任务列表以追踪进度。在分步模式下，这是规划期间唯一可用的工具 — agent 必须在任何执行开始前创建完整计划。 |
| `write_summary` | 使用模板编写最终**结构化摘要**：`### 所做更改`、`### 验证`、`### 结果`。模糊的摘要会被**拒绝**。如果使用了 `write_todos`：摘要还必须包含 `### Todo 进度` 部分，列出每个项目的最终状态。成功后，UI 将摘要渲染一次到 `agent-body` 中作为 markdown 预览，而不是作为工具卡片。 |
| `task_complete` | 完成任务运行。没有参数，**除非已调用 `write_summary`，否则会被拒绝**。如果任何 todo 项目仍为 pending/in_progress 也会被拒绝。SSE `done` 回复重用存储的摘要，但客户端会去重，因此最终摘要不会渲染两次。 |
| `delegate_task` | 将子任务委托给专门的子 agent（browser、code-search、code-writer、researcher、planner、frontend-specialist、backend-specialist、security-auditor、architect-analyst、docs-analyst、documentation-writer），子 agent 在自己的上下文窗口中独立运行。子 agent 顺序运行 — 每个必须在下一个开始前完成。 |

### 多 Agent 委托

Harness 支持**子 agent 委托** — 主 agent 可以生成专门的子 agent 来隔离处理复杂的子任务。每个子 agent 拥有自己的上下文窗口，因此其对话历史不会膨胀父 agent 的上下文。子 agent **顺序**运行 — 每个必须在下一个开始前完成，以管理 RAM 使用。

#### 架构

```
┌──────────────────────────────────────────────┐
│  父 Agent（编排器）                           │
│  - 使用 write_todos 分解用户请求              │
│  - 为每个子任务调用 delegate_task              │
│  - 在子 agent 运行时暂停                       │
│  - 恢复、综合、编写摘要                         │
│  - 调用 task_complete                          │
└──────┬───────────────────────────────────────┘
       │  delegate_task 启动子 agent
       │  子 agent 工具实时流式传输到 UI
       │  （每个都有子 agent 颜色编码）
       ▼
┌──────────────────────────────────────────────┐
│  子 Agent（隔离的 AgentState + 上下文）       │
│  ┌─ tool_start read_file ──► 结果           │
│  ├─ tool_start edit_file  ──► 结果          │
│  ├─ tool_start run_command ─► 结果          │
│  └─ 向父 agent 返回最终纯文本报告              │
│  浏览器子 agent 暂停等待渲染器                 │
│  结果并通过 /continue 恢复                    │
└──────────────────────────────────────────────┘
       │
       ▼
父 agent 恢复 ← 结果推送到父 agent 的 state.messages
```

#### Agent 配置文件

| 配置文件 | 工具 | 迭代次数 | 描述 |
|---------|------|----------|------|
| `browser` | `browser_navigate`、`browser_info`、`browser_screenshot`、`browser_get_dom`、`browser_click`、`browser_type`、`browser_clear`、`browser_select`、`browser_press_key`、`browser_console`、`browser_request_errors`、`browser_scroll`、`browser_wait`、`browser_move_mouse`、`browser_right_click`、`browser_upload_file` | 100 | 完整浏览器自动化 — 无限轮次用于密集测试。导航、点击、输入、滚动、填写表单、检查 DOM/控制台/网络。 |
| `code-search` | `read_file`、`list_files`、`search_files`、`grep`、`read_graph` | 20 | 只读代码探索。查找文件、读取代码、报告发现。从不编辑。 |
| `code-writer` | 完整文件系统 + `run_command`、`read_problems`、`read_graph` | 50 | 实现功能或修复 Bug。读取、编辑、构建和验证。 |
| `researcher` | `read_file`、`list_files`、`search_files`、`grep`、`run_command`、`read_graph` | 25 | 探索代码库回答问题。报告文件路径和行号。 |
| `planner` | `read_file`、`list_files`、`search_files`、`grep`、`read_graph`、`write_todos` | 25 | 分析项目并创建结构化的分步计划。输出包含有序、可操作步骤的 todo 列表。 |
| `frontend-specialist` | 完整文件系统 + `run_command`、`read_problems`、`read_graph`、`browser_screenshot`、`browser_get_dom`、`browser_console`、`browser_request_errors` | 50 | 实现 UI 功能和组件。在浏览器中可视化验证更改。 |
| `backend-specialist` | 完整文件系统 + `run_command`、`read_problems`、`read_graph` | 50 | 实现 API 路由、服务和数据库逻辑。关注服务器端模式和数据完整性。 |
| `security-auditor` | `read_file`、`list_files`、`search_files`、`grep`、`run_command`、`read_graph`、`read_problems` | 30 | 审核代码漏洞。运行安全扫描，报告发现及严重性和修复建议。从不编辑。 |
| `architect-analyst` | `read_file`、`list_files`、`search_files`、`grep`、`read_graph` | 25 | 分析项目架构、依赖图和模块结构。报告架构问题和建议。从不编辑。 |
| `docs-analyst` | `read_file`、`list_files`、`search_files`、`grep`、`read_graph` | 20 | 审核文档覆盖率和质量。识别文档缺口和过时文档。从不编辑。 |
| `documentation-writer` | `read_file`、`write_file`、`edit_file`、`list_files`、`search_files`、`grep`、`read_graph`、`create_directory` | 30 | 创建或改进文档。编写 README 章节、API 文档和指南。 |

#### 关键设计

| 特性 | 详情 |
|---------|------|
| **上下文隔离** | 每个子 agent 拥有自己的 `AgentState` — 消息不会污染父 agent 的上下文 |
| **工具白名单** | 子 agent 仅接收其配置文件指定的工具（例如 code-search 永远不能写文件） |
| **无头执行** | 所有非浏览器子 agent 完全在服务器端运行 — 没有浏览器或终端工具。frontend-specialist 具有只读浏览器工具用于可视化验证。 |
| **浏览器委托** | 父 agent 没有浏览器工具 — 连只读的也没有。所有浏览器交互（导航、检查 DOM、截图、检查控制台/网络、点击、输入、滚动）通过 `delegate_task agent_type: "browser"` 的浏览器子 agent 进行。这保持主 agent 上下文的清洁，并强制结构化委托。 |
| **实时流式传输** | 子 agent 工具调用实时流式传输到 UI，作为彩色工具卡片实时显示。父 agent 在委托期间显示为暂停状态。子 agent 文本事件被过滤 — 仅显示 tool_start/tool_end 卡片，防止消息污染。 |
| **结果汇总** | 子 agent 结果在返回给父 agent 之前被压缩，保留上下文预算 |
| **并行性** | 不支持 — 子 agent 顺序运行。每个必须在下一个开始前完成，以管理 RAM 使用。Agent 应为独立的子任务多次调用 `delegate_task`。 |
| **颜色编码** | 每个工具卡片有一个左边框颜色：蓝色（主 agent）、青色（browser）、绿色（code-search）、琥珀色（code-writer）、紫色（researcher）、靛蓝（planner）、青色（frontend-specialist）、蓝色（backend-specialist）、红色（security-auditor）、橙色（architect-analyst）、浅绿（docs-analyst）、粉红（documentation-writer）。便于识别哪个 agent 执行的每个工具调用。 |
| **Agent 底部状态** | 当对话正常结束时（SSE `done` 事件）显示"已完成"。仅在错误或 5 分钟安全超时时显示"已停止"。底部标签严格对应 SSE 流状态 — 不是应用焦点。 |
| **后台运行** | SSE 流使用基于 `fetch` 的流式传输 — 独立于窗口焦点运行。Agent 对话在最小化或在其他窗口后面时继续在后台运行，不会中断。 |

#### 使用方式

父 agent 像使用其他工具一样使用这些工具：

```
Agent: write_todos todos=[
  {id:1 text:"研究现有认证代码" status:pending},
  {id:2 text:"添加登录端点" status:pending}
]

Agent: delegate_task task="查找项目中所有与认证相关的代码。
  报告文件路径、行号和使用的模式。"
  agent_type="code-search"

→ [代码搜索 Agent] 在 4 轮内完成。
  在以下位置找到认证代码：
  - server/auth.ts:45-120（JWT 验证、密码哈希）
  - client/src/Login.tsx:1-80（登录表单组件）
  ...
```

**浏览器 Agent 示例** — 子 agent 现在可以交互式地导航、点击、输入和检查页面：

```
父 agent: delegate_task task="前往 http://localhost:3000/login，
  在邮箱字段中输入 'admin'，在密码字段中输入 'pass123'，
  点击登录，并报告发生的情况。"
  agent_type="browser"

→ [浏览器 Agent] browser_navigate http://localhost:3000/login
  → 渲染器执行 → 页面加载
→ [浏览器 Agent] browser_get_dom
  → 渲染器返回标准化的位置稳定网格中的索引元素
    (V:WxH、XX|N 分段、A/A+ 标志)
    在密集页面上，分割为区域如 "Band 1/2 y:0-450"
    以便 agent 一次读取一个区域。
→ [浏览器 Agent] browser_click index=12  (带 A+ 标志的邮箱输入框)
  → 渲染器点击 → 输入框获得焦点
→ [浏览器 Agent] browser_type index=12 text="admin"
  → 渲染器输入 → "admin" 已输入
→ [浏览器 Agent] browser_click index=15  (密码输入框)
→ [浏览器 Agent] browser_type index=15 text="pass123"
→ [浏览器 Agent] browser_click index=18  (带 A+ 标志的登录按钮)
→ [浏览器 Agent] browser_screenshot
  → 渲染器返回 URL、标题、区域分割网格
    （如果视口密集则自动分割为区域），
    以及过滤的错误文本
  → 在 Band 2, Middle-Center 部分看到 "Welcome, admin!"

→ [浏览器 Agent] 在 10 轮内完成。
  登录测试：成功。已导航到登录页面，
  填写邮箱和密码字段，点击登录。
  结果：显示 "Welcome, admin!"。
```

**并行示例** — code-writer + researcher 同时运行：

```
Agent: delegate_parallel tasks=[
  {task:"在 server/auth.ts 中实现 POST /api/login", agent_type:"code-writer"},
  {task:"研究现有 API 路由如何处理错误响应", agent_type:"researcher"}
]

→ 2 个子 agent 已完成。
  [1] 向 server/auth.ts 写入了约 500 token。构建通过。
  [2] 在 server/middleware.ts:30-55 找到错误处理模式...
```

#### 何时使用

- **`delegate_task`**：对于需要多轮完成的复杂子任务（深度研究、功能实现、多文件重构、浏览器测试）。对于多个独立的子任务，依次调用 `delegate_task` — 每个在下一个开始前完成。

### IDE 驱动的分步执行（强制 Todo）

在默认的 agent 循环中，LLM 控制何时创建、更新和完成 todo — 它可能跳过步骤、忘记更新或跳到最后。**分步模式**反转了这一点：**IDE/服务器锁定 todo 列表**，并通过隔离的子 agent 强制 agent 逐步完成每个步骤。

#### 工作原理

```
用户发送任务 → POST /api/chat/agent/stream/stepbystep

阶段 1：规划 (PLANNING)
  Agent 只有 write_todos — 没有其他工具
  Agent 必须创建完整、有序的计划
  → 服务器验证（非空、具体步骤）

阶段 2：锁定 (LOCKED)
  服务器锁定 todo 列表 → SSE "step_plan" 事件
  UI 在待处理横幅中渲染锁定的计划

阶段 3：执行 (EXECUTE)（每个步骤）
  对于每个待处理的 todo：
    → SSE "step_begin" 事件
    → 生成 code-writer 子 agent，仅使用此步骤的上下文
    → 子 agent 具有完整文件系统 + run_command 工具（最多 50 次迭代）
    → 流式 tool_start/tool_end 事件显示在 UI 中
    → 子 agent 返回最终纯文本报告 → SSE "step_end" 事件
    → 步骤标记为已完成/失败，开始下一步
  先前步骤的结果作为上下文传递给后续步骤

阶段 4：收尾 (WRAP-UP)
  → SSE "done" 事件，包含 allStepResults 汇总
```

#### 与默认模式的主要区别

| 方面 | 默认模式 | 分步模式 |
|--------|----------|----------|
| 规划 | Agent 可以在同一轮中规划和执行 | 严格分离：先规划，后执行 |
| Todo 所有权 | Agent 驱动 — LLM 选择何时更新 | IDE 驱动 — 服务器锁定 todo，强制推进 |
| 执行 | Agent 随时处理任何事情 | 一次一步，每步隔离的子 agent |
| 上下文 | 完整对话历史在一个循环中 | 每步获得仅包含该步 + 先前结果的新子 agent |
| 工具限制 | 完整工具集可用 | 规划：仅 write_todos。执行：code-writer 工具（无浏览器/终端） |
| 最大轮数 | 每 agent 循环 50 次 | 规划：5 轮。每步：50 轮（可按 agent 配置文件配置） |

#### 为什么使用它

- **确定性执行**：服务器强制执行 todo 推进 — agent 不能跳过或忘记步骤
- **隔离的失败处理**：如果某步骤的子 agent 失败，后续步骤仍然运行，并具有清晰的失败上下文
- **每步清洁的上下文**：每个步骤的子 agent 从头开始，避免早期步骤造成的上下文膨胀
- **可验证的进度**：UI 显示锁定的计划，包含每步状态（pending → in_progress → completed/failed）

#### 摘要锁定

Harness 对 `write_summary` 强制执行**结构化摘要**。服务器根据所需模板验证每个摘要，并拒绝 `task_complete`，除非已调用 `write_summary`。

```
### 所做更改
- [文件路径]：[更改了什么]
### 验证
- [构建/测试/检查结果]
### 结果
- [完成内容的简明描述]
```

太短、匹配思考过程模式（例如"我完成了任务"、"好的，已完成"）或缺乏具体细节（无文件引用、操作或结果）的摘要会被**拒绝**。Agent 将拒绝作为工具错误接收，必须使用适当的摘要重新调用 `write_summary`。

### 持久化记忆

Harness 包含一个基于 SQLite 的**跨会话记忆系统**。Agent 可以存储关键决策、用户偏好、项目约定和发现的模式 — 并在未来的会话中回忆它们。

#### 工作原理

```
Agent 检测到重要事实
  → 调用 remember(key, value, category, tags)
  → 值可选择性地通过 DeepSeek embeddings API 进行嵌入
  → 存储在 ~/.harness/store/memory.db（SQLite，全局用户存储）

下一会话：
  → Agent 调用 recall(query: "UI framework")
  → 语义搜索（如存在嵌入则为余弦相似度）
  → 如果 embedding API 不可用，回退到关键词搜索
  → 返回带分数的排序结果
```

#### 工具

| 工具 | 描述 |
|------|------|
| `remember` | 存储关键决策、用户偏好、项目约定或重要事实。在 SQLite 中跨会话持久化。分类：`decision`、`preference`、`convention`、`fact`、`pattern`、`general`。标签帮助分组相关记忆。值可选择性地通过 DeepSeek API 嵌入以进行语义搜索。 |
| `recall` | 按语义或精确键搜索存储的记忆。如果嵌入可用，使用余弦相似度搜索。否则回退到键、值、标签和分类的关键词匹配。不传参数则列出所有记忆。 |
| `forget` | 按其键移除存储的记忆。当决策被撤销、偏好改变或存储的信息过时时使用。 |

#### 存储

| 详情 | 值 |
|--------|------|
| 数据库 | SQLite（WAL 模式）位于 `~/.harness/store/memory.db`（全局，不在项目目录中） |
| API Keys | AES-256-GCM 加密文件位于 `~/.harness/store/api-keys.enc`（持久化，在重启和应用更新后仍然存在） |
| 客户端状态 | JSON 文件位于 `~/.harness/store/client-state.json` — 镜像所有浏览器 `localStorage` 数据（模型、聊天历史、最近路径、打开标签页、预设、终端历史），以便在重装后仍然存在 |
| Schema | `id`、`key`（唯一）、`value`、`category`、`tags`、`embedding`（BLOB）、`created_at`、`updated_at` |
| 嵌入 | 通过 DeepSeek `/v1/embeddings` 端点生成（可选；如果不可用则优雅回退到关键词搜索） |
| 检索 | 嵌入余弦相似度搜索 → 关键词 `LIKE` 回退 → 列出全部 |

#### Agent 何时使用记忆

- **主动存储**：当用户说"让我们用 X"，"我更喜欢 Y"，或建立项目约定时，Agent 无需被要求即可调用 `remember`。
- **会话启动**：Agent 被指示在任务开始时 `recall` 相关记忆，以获取过去的决策和偏好。
- **记忆清理**：当偏好改变或决策被撤销时，Agent 可以 `forget` 过时的条目。

#### 文件

| 文件 | 职责 |
|------|------|
| `server/memory.ts` | `MemoryStore` 类 — SQLite CRUD、embedding 搜索、余弦相似度、全局单例 |
| `server/deepseek.ts` | `generateEmbedding()` — 调用 DeepSeek embeddings API，返回 `Float32Array` |
| `server/agent.ts` | `runMemoryTool()` — 工具执行处理程序；在 `agentLoop()` 和 `agentLoopStream()` 中均已连接 |

## Agent 命令目录

Agent 可以通过 `run_command` 或 `run_in_terminal` 发出的每个 shell 命令。这些命令提取自 agent 的系统提示片段和 [server/agent.ts](file:///d:/Work Projects/Harness/server/agent.ts) 中的 `detectProjectBuild()` 自动检测逻辑。

### JavaScript / TypeScript

| 命令 | 用途 | 来源 |
|---------|------|------|
| `npx tsc --noEmit` | 类型检查所有文件（首选） | `LANG_JS` + `detectProjectBuild` |
| `npm run build` | 通过 package.json scripts 完整构建 | `LANG_JS` + `detectProjectBuild` |
| `npx eslint .` | Lint 所有文件 | `LANG_JS` |
| `npm install` | 安装所有项目依赖 | `LANG_JS` |
| `npm install <pkg>` | 安装特定包 | `LANG_JS` |

### Python

| 命令 | 用途 | 来源 |
|---------|------|------|
| `python -m py_compile <file>.py` | 单文件语法检查 | `LANG_PYTHON` |
| `python -m compileall .` | 语法检查所有 .py 文件 | `LANG_PYTHON` + `detectProjectBuild` |
| `python -m pytest` | 运行测试 | `LANG_PYTHON` |
| `pip install -r requirements.txt` | 安装所有项目依赖 | `LANG_PYTHON` |
| `pip install <pkg>` | 安装单个包 | `LANG_PYTHON` + `SERVER_STARTUP` |

### Go

| 命令 | 用途 | 来源 |
|---------|------|------|
| `go build ./...` | 编译所有包 | `LANG_GO` |
| `go vet ./...` | 静态分析 | `LANG_GO` + `detectProjectBuild` |
| `go test ./...` | 运行所有测试 | `LANG_GO` |

### Rust

| 命令 | 用途 | 来源 |
|---------|------|------|
| `cargo check` | 快速编译检查（无二进制文件） | `LANG_RUST` + `detectProjectBuild` |
| `cargo build` | 完整编译 | `LANG_RUST` |
| `cargo test` | 运行测试 | `LANG_RUST` |
| `cargo clippy` | 带额外警告的 lint | `LANG_RUST` |

### Java

| 命令 | 用途 | 来源 |
|---------|------|------|
| `mvn compile` | Maven 构建 | `LANG_JAVA` + `detectProjectBuild` |
| `gradle build` | Gradle 构建 | `LANG_JAVA` |
| `gradle compileJava` | Gradle 仅编译 | `detectProjectBuild` |
| `javac <File>.java` | 单文件（无构建工具） | `LANG_JAVA` |

### C / C++

| 命令 | 用途 | 来源 |
|---------|------|------|
| `gcc -Wall -Wextra <file>.c -o output` | 单 C 文件带警告 | `LANG_C` |
| `g++ -Wall -Wextra <file>.cpp -o output` | 单 C++ 文件带警告 | `LANG_C` |
| `cmake --build build` | CMake 项目 | `LANG_C` + `detectProjectBuild` |
| `make` | Makefile 项目 | `LANG_C` + `detectProjectBuild` |

### Ruby

| 命令 | 用途 | 来源 |
|---------|------|------|
| `ruby -c <file>.rb` | 语法检查（安全，不执行） | `LANG_RUBY` + `detectProjectBuild` |
| `bundle exec rake test` | 通过 Rake 运行测试 | `LANG_RUBY` |
| `bundle exec rspec` | 运行 RSpec 测试 | `LANG_RUBY` |
| `bundle install` | 安装 gem 依赖 | `LANG_RUBY` |
| `gem install <pkg>` | 安装单个 gem | `LANG_RUBY` |

### PHP

| 命令 | 用途 | 来源 |
|---------|------|------|
| `php -l <file>.php` | 单文件语法 lint | `LANG_PHP` |
| `php -l *.php` | Lint 所有 PHP 文件 | `LANG_PHP` + `detectProjectBuild` |
| `composer install` | 安装依赖 | `LANG_PHP` |

### Shell (Bash)

| 命令 | 用途 | 来源 |
|---------|------|------|
| `bash -n <script>.sh` | 语法检查（不执行） | `LANG_SHELL` |
| `shellcheck <script>.sh` | 静态分析（如果已安装） | `LANG_SHELL` |

### 跨语言 / 通用

| 命令 | 用途 | 来源 |
|---------|------|------|
| `git status --porcelain -u` | 暂存/未暂存文件追踪 | 服务器 SCM API |
| `git log --max-count=20` | 最近提交历史 | 服务器 SCM API |
| `git diff -- <file>` | 显示文件的未暂存变更 | 服务器 SCM API |
| `git fetch --all` | 从所有远程获取 | 服务器 SCM API |
| `git pull` | 拉取最新更改 | 服务器 SCM API |
| `git push` | 推送本地提交 | 服务器 SCM API |

### 项目自动检测（`read_problems`）

当 agent 调用 `read_problems` 时，服务器自动检测项目类型并运行：

| 检测信号 | 自动命令 |
|----------|----------|
| 存在 `Cargo.toml` | `cargo check 2>&1` |
| 存在 `go.mod` | `go vet ./... 2>&1` |
| 存在 `pom.xml` | `mvn compile 2>&1` |
| 存在 `build.gradle` 或 `build.gradle.kts` | `gradle compileJava 2>&1` |
| `package.json` + `tsconfig.json` | `npx tsc --noEmit 2>&1` |
| `package.json` 带 build script | `npm run build 2>&1` |
| `package.json`（无 tsconfig，无 build script） | `npx tsc --noEmit 2>&1` |
| `requirements.txt` / `pyproject.toml` / `setup.py` / `.py` 文件 | `python -m compileall . 2>&1` |
| 存在 `Gemfile` | `ruby -c *.rb 2>&1` |
| 存在 `composer.json` | `php -l *.php 2>&1` |
| 存在 `Makefile` | `make 2>&1` |
| 存在 `CMakeLists.txt` | `cmake --build build 2>&1` |
| 以上都不是 | `npx tsc --noEmit` / `python -m compileall .` / `go vet ./...`（通用建议） |

### 服务端特定命令（通过 `run_in_terminal`）

Agent 被指示在真实终端标签页中启动的命令：

| 框架 | 典型命令 | 提及位置 |
|-----------|----------|----------|
| Python（通用） | `python app.py` / `python server.py` | `run_command` 阻止列表 |
| Flask | `flask run` | `run_command` 阻止列表 |
| Django | `python manage.py runserver` | `run_command` 阻止列表 |
| FastAPI | `uvicorn main:app` | `run_command` 阻止列表 |
| Gunicorn | `gunicorn app:app` | `run_command` 阻止列表 |
| Node.js (Express) | `node server.js` | `run_command` 阻止列表 |
| npm scripts | `npm start` / `npm run dev` | `run_command` 阻止列表 |
| Next.js | `next dev` / `next start` | `run_command` 阻止列表 |
| Vite | `vite` | `run_command` 阻止列表 |
| Go | `go run .` | `run_command` 阻止列表 |
| Rust | `cargo run` | `run_command` 阻止列表 |
| Webpack | `webpack-dev-server` | `run_command` 阻止列表 |
| npx 运行器 | `npx serve`、`npx vite`、`npx next` | `run_command` 阻止列表 |

> **注意：** 这些服务端命令在 `run_command` 中被阻止，并重定向到 `run_in_terminal`。Agent 被明确告知对所有服务端启动命令使用 `run_in_terminal`。

## 按语言排查问题

Agent 知道如何诊断和修复每种语言栈的错误。以下是指引 — 有助于理解当构建失败时 agent 将做什么。

### JavaScript / TypeScript

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 类型检查 | `run_command` | `npx tsc --noEmit` |
| 完整构建 | `run_command` | `npm run build`（先检查 `package.json`） |
| 仅 Lint | `run_command` | `npx eslint .` |
| 缺少模块 | `run_command` | `npm install <pkg>` |
| 浏览器中的运行时错误 | `browser_console` | 启动开发服务器后，检查控制台输出 |
| 失败的 API 调用 | `browser_request_errors` | 检查浏览器中的 404/500/CORS 错误 |
| 查找定义 | `grep` | 跨项目文件的正则搜索 |

### Python

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 语法检查（单文件） | `run_command` | `python -m py_compile <file>.py` |
| 语法检查（所有文件） | `run_command` | `python -m compileall .` |
| 运行测试 | `run_command` | `python -m pytest` |
| 安装依赖 | `run_command` | `pip install -r requirements.txt` 或 `pip install <pkg>` |
| Flask/Django 运行时错误 | `browser_screenshot` 或 `browser_get_dom` | Flask 调试模式在浏览器中显示完整 traceback；带位置桶和 `A`/`A+` 标志的标准化网格有助于区分导航 chrome 与实际错误面板 |
| 后端 HTTP 错误 | `browser_request_errors` | 检查 500 错误和 CORS 问题 |
| 查找函数定义位置 | `grep` | `def <name>` 或 `class <Name>` |
| 读取堆栈跟踪 | `read_file` | 在 traceback 中的行号打开失败文件 |

### Go

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 编译检查 | `run_command` | `go build ./...` |
| 静态分析 | `run_command` | `go vet ./...` |
| 运行测试 | `run_command` | `go test ./...` |
| 未使用的导入 | `edit_file` | 移除导入行（Go 禁止未使用的导入） |
| 查找定义 | `grep` | `func <Name>` 或 `type <Name>` |

### Rust

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 快速编译检查 | `run_command` | `cargo check`（首选 — 不输出二进制文件） |
| 完整构建 | `run_command` | `cargo build` |
| Lint | `run_command` | `cargo clippy` |
| 运行测试 | `run_command` | `cargo test` |

### Java

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| Maven 编译 | `run_command` | `mvn compile` |
| Gradle 构建 | `run_command` | `gradle build` |
| 单文件编译 | `run_command` | `javac <File>.java` |
| 查找类定义 | `grep` | `class <Name>` |

### C / C++

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 带警告编译 | `run_command` | `gcc -Wall -Wextra <file>.c -o output` |
| CMake 构建 | `run_command` | `cmake --build build` |
| Make 构建 | `run_command` | `make` |
| 查找函数定义 | `grep` | `void <name>(` 或 `int <name>(` |

### Ruby

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 语法检查 | `run_command` | `ruby -c <file>.rb` |
| 安装依赖 | `run_command` | `bundle install` |
| 运行测试 | `run_command` | `bundle exec rspec` 或 `bundle exec rake test` |

### PHP

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 语法 lint | `run_command` | `php -l <file>.php` |
| 安装依赖 | `run_command` | `composer install` |

### Shell (Bash)

| 场景 | 工具 | 命令 / 方法 |
|---|---|---|
| 语法检查 | `run_command` | `bash -n <script>.sh` |
| 静态分析 | `run_command` | `shellcheck <script>.sh` |

### 一般排查流程

1. **启动服务器**（`run_in_terminal`）— 用户必须允许
2. **检查构建错误**（`run_command`）— 通过 `edit_file` / `write_file` 修复
3. **验证页面加载**（`browser_info` → `browser_screenshot` / `browser_get_dom`，然后使用标准化网格、位置桶和 `A`/`A+` 标志定位正确元素）
4. **检查浏览器运行时错误**（`browser_console`、`browser_request_errors`）
5. **在进行修复前读取相关源文件**（`read_file`）
6. **进行精确编辑**（`edit_file` — 仅发送变更的行）
7. **重建并验证** — 重复直到干净

### 避免工具幻觉

Agent 使用固定的工具注册表。为防止其虚构不存在的工具：

- **读取文件** → 使用 `read_file`（永远不要 `cat`、`head`、`tail`）
- **列出目录** → 使用 `list_files`（永远不要 `ls`、`dir`）
- **按名称查找文件** → 使用 `search_files`（永远不要 `find`、`locate`）
- **搜索文件内容** → 使用 `grep`（工具，而非 shell 命令）
- **编辑文件** → 使用 `edit_file`（永远不要 `sed`、`awk`）
- **写入文件** → 使用 `write_file`（永远不要 `echo >`、`cp`）
- **运行命令** → 短任务使用 `run_command`，服务器使用 `run_in_terminal`（永远不要使用 `&` 或 `nohup` 后台运行）
- **检查诊断** → 使用 `read_problems`（不要直接使用 `tsc`、`eslint` 或 `pylint` — 这些通过 `run_command` 执行）
- **依赖/结构查询** → 使用 `read_graph`（什么导出 X？谁从 Y 导入？）— 对于这类查询比 grep 快得多
- **启动服务器** → 仅使用 `run_in_terminal`（永远不要用 `run_command` 执行 `python app.py`、`npm start` 等）

## MCP（模型上下文协议）

Harness 可以作为 **MCP 服务器**，将其文件系统、终端、git 和系统工具暴露给任何兼容 MCP 的客户端（Claude Desktop、Cursor、带 Copilot 的 VS Code 等）。

### 使用哪种传输方式

配置取决于你如何运行 Harness：

| 场景 | 传输方式 | 原因 |
|----------|-----------|------|
| **开发模式**（源码检出） | Stdio 或 SSE | 两者均可；stdio 给你项目隔离 |
| **Electron 桌面应用**（已打包） | **仅 SSE** | Express 服务器已在 Electron 内运行 — 无需额外进程 |

> **在 Electron 应用中：** Harness Express 服务器在 Electron 主进程内启动。MCP 端点（`/api/mcp`、`/api/mcp/sse`）在服务器分配的端口上自动可用。你不需要单独的进程或指向源代码的 `cwd` — 只需通过 SSE 连接。

### 开发模式（源码检出）

从源码运行 Harness 时（`npm run dev`），你有两种选择：

#### 选项 A：SSE（最简单 — 无需额外配置）

启动服务器，然后将任何 MCP 客户端指向运行的端点（查看控制台输出获取端口，或读取 `%TEMP%/harness-ports/express-port`）：

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://localhost:<port>/api/mcp/sse"
    }
  }
}
```

适用于 Claude Desktop、Cursor、VS Code 和任何兼容 SSE 的客户端。

#### 选项 B：Stdio（项目隔离）

为每个项目运行单独的进程。`cwd` 指向 Harness 源码检出，以便找到 `tsx` 和服务器文件：

```powershell
npx tsx server/mcp-server.ts "D:\my-project"
```

Claude Desktop 配置（`%APPDATA%\Claude\claude_desktop_config.json`）：

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

Cursor 配置（`Settings > MCP > Add Server`）：

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

### Electron 桌面应用（已打包）

当 Harness 作为桌面应用安装时，服务器自动启动。端口写入 `%TEMP%/harness-ports/express-port`。仅使用 SSE 传输 — 无需 `command`/`cwd`：

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://localhost:<port>/api/mcp/sse"
    }
  }
}
```

嵌入式 Express 服务器处理所有 MCP 请求。项目根目录自动设置为 Harness UI 中当前打开的项目文件夹，因此 `read_file`、`grep` 和 `run_command` 等工具会自动在正确的项目上操作。

**为什么 stdio 模式不适用于打包的 Electron 应用：**

- 用户机器上没有 `tsx` 运行时
- 源文件（`server/mcp-server.ts`）是编译/打包的，不在磁盘上
- Express 服务器已在 Electron 内运行 — 生成第二个进程是多余的

如果你确实需要从打包应用使用 stdio，可以将 MCP 入口点编译为独立的 `.cjs` 文件并与应用一起打包。但 SSE 是预期的方式。

### MCP 工具

通过 MCP 暴露以下工具：

| 工具 | 描述 |
|------|------|
| `read_file` | 带行号读取文件或列出目录 |
| `write_file` | 创建或覆盖文件 |
| `edit_file` | 文件中的精确字符串替换 |
| `list_files` | 列出路径中的文件和目录 |
| `search_files` | 按名称模式查找文件/文件夹 |
| `grep` | 使用正则搜索文件内容 |
| `run_command` | 执行 shell 命令（沙箱化，无需授权） |
| `create_directory` | 创建目录（及父目录） |
| `delete_file` | 删除文件或目录（递归） |
| `rename_file` | 重命名或移动文件或目录 |
| `git_status` | 获取暂存和未暂存的 git 变更、当前分支 |
| `git_log` | 获取最近提交历史 |
| `git_diff` | 获取特定文件的差异 |
| `system_info` | 获取 CPU、内存、磁盘、操作系统详情 |

### 协议详情

Harness 实现 **MCP 协议版本 `2024-11-05`**，采用 JSON-RPC 2.0：

1. **初始化** — 客户端发送 `initialize` → 服务器返回能力和服务器信息
2. **列出工具** — 客户端发送 `tools/list` → 服务器返回带 JSON Schema 的工具定义
3. **调用工具** — 客户端发送 `tools/call` → 服务器执行工具并返回 `{ content: [{ type: "text", text: "..." }] }`

服务器仅暴露 **tools** 能力 — 没有 resources 或 prompts。

### MCP 交换示例

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"harness","version":"1.0.0"}}}

→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}

→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"server/index.ts","limit":10}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"   1| import \"dotenv/config\";\n..."}],"isError":false}}
```

## 项目结构

```
Harness/
├── .env.example                     # 环境变量模板（DeepSeek API Key）
├── package.json                     # 根依赖（Express、better-sqlite3、node-pty）、脚本（dev、test、desktop:build）
├── package-lock.json
├── tsconfig.json                    # 服务器 TypeScript 配置（ES2022、strict、vitest globals）
├── vitest.config.ts                 # Vitest 运行器配置（node env、30s 超时）
├── README.md                        # 你正在阅读的文档
│
├── build/
│   └── 图标资源 (ico, png, svg)      # Electron 应用图标
│
├── scripts/
│   ├── embed-icon.js                # 将图标嵌入 Electron 可执行文件
│   └── generate-icon.js             # 从 SVG 源生成图标
│
├── server/
│   ├── index.ts                     # Express 服务器入口：API 路由、WebSocket 终端、agent SSE 流式传输、MCP、浏览器代理、系统状态
│   ├── agent.ts                     # Agent 核心：27 个工具定义、11 个子 agent 配置、delegate_task、agentLoop/Stream/StepByStep、权限控制、ITR 系统提示构建器、历史压缩
│   ├── deepseek.ts                  # DeepSeek API 客户端：阻塞 + 流式聊天（带工具调用）、嵌入、KV 缓存追踪、用量报告
│   ├── terminalManager.ts           # 终端会话管理器：PTY（node-pty）和管道回退、WebSocket I/O、venv 自动激活、localhost URL 检测
│   ├── lsp.ts                       # LSP 客户端：启动语言服务器（pyright、gopls 等）、SSE 诊断流式传输、30+ 语言
│   ├── mcp.ts                       # MCP 服务器：JSON-RPC 处理程序、外部 AI 客户端的工具集、stdio + SSE 传输
│   ├── mcp-server.ts                # 独立 MCP 服务器入口点（stdio 模式）
│   ├── memory.ts                    # SQLite 持久化记忆存储（~/.harness/store/memory.db）：关键词 + embedding 搜索，供 agent remember/recall/forget 工具使用
│   ├── cryptoStore.ts               # AES-256-GCM 加密的 API Key 存储（~/.harness/store/api-keys.enc）
│   ├── harnessPaths.ts              # ~/.harness/ 目录结构的集中路径解析
│   ├── fileTracking.ts              # 智能文件追踪：自动检测 Git vs fs.watch 监视器模式、会话中期 Git 检测、快照/补丁文件树上下文
│   ├── fileTrackingStore.ts         # JSON 支持的文件元数据缓存（~/.harness/store/file-tracking.json），供监视器模式使用
│   ├── knowledgeGraph.ts            # 代码库知识图谱构建器：目录/文件节点、CONTAINS + IMPORTS 边、.kg 序列化、可视化
│   └── __tests__/
│       ├── agent.tooldefs.test.ts    # 工具定义 Schema 验证
│       ├── agent.fs.test.ts          # 文件系统工具执行测试
│       ├── agent.command.test.ts     # 命令执行测试
│       ├── agent.loop.test.ts        # Agent 循环集成测试
│       └── api.test.ts              # API 端点集成测试
│
├── client/
│   ├── package.json                 # 客户端依赖（React 18、Monaco、xterm.js）、Vite + TypeScript
│   ├── vite.config.ts               # Vite 开发配置：从 %TEMP%/harness-ports/express-port 读取 Express 端口，代理 /api + /ws + /_browser
│   ├── tsconfig.json                # 客户端 TypeScript 配置（ES2020、DOM、react-jsx）
│   ├── index.html                   # SPA 入口：在 <div id="root"> 中挂载 React 应用
│   ├── public/
│   │   └── icon.svg                 # 应用图标 SVG
│   └── src/
│       ├── main.tsx                 # React DOM 入口：渲染 <App />
│       ├── App.tsx                  # 根组件：文件夹选择器、会话状态、可调整大小的布局（编辑器 + agent 控制台）
│       ├── App.css                  # 全局暗色主题样式：面板布局、编辑器 chrome、agent 卡片、子 agent 颜色编码（11 种 agent 类型）、欢迎屏幕
│       ├── electron.d.ts            # window.harnessDesktop 桥接和 <webview> JSX 的类型声明
│       ├── vite-env.d.ts            # Vite 客户端类型声明
│       ├── stateSync.ts             # 客户端状态持久化：将所有 localStorage 镜像到 ~/.harness/store/client-state.json（重装后仍存在）
│       ├── panes/
│       │   ├── EditorPane.tsx       # 主编辑器：Monaco 标签页、文件树、浏览器标签页条、终端、菜单栏、状态栏
│       │   ├── AgentConsole.tsx     # Agent 聊天 UI：流式消息、diff 预览、授权提示、带 agent 颜色编码的工具卡片、markdown 渲染
│       │   ├── TerminalPane.tsx     # xterm.js 终端：WebSocket 支持的 PTY、Ctrl+点击链接、回滚、agent 桥接
│       │   ├── FilesPanel.tsx       # 文件资源管理器树：虚拟文件 + 后端 FsEntry、创建/重命名/删除
│       │   ├── BrowserView.tsx      # 嵌入式浏览器：iframe 代理、getIndexedDom/clickElement/typeIntoElement agent API、DOM 索引辅助函数
│       │   ├── MenuBar.tsx          # 下拉菜单：文件、编辑、视图、运行、帮助，带键盘快捷键
│       │   ├── StatusBar.tsx        # 状态栏：光标位置、编码、缩进、语言、LSP 错误、记忆数量
│       │   ├── ScmPanel.tsx         # 源码控制：git 状态、提交日志、fetch/pull/push、diff
│       │   ├── NameDialog.tsx       # 模态对话框：创建/重命名文件和文件夹
│       │   ├── PathDialog.tsx       # 模态对话框：手动打开文件夹路径
│       │   ├── AgentTerminalBridge.ts # 桥接：agent 命令 → 真实终端执行
│       │   ├── fileModel.ts         # VFile 类型、detectLanguage()、文件/文件夹图标辅助函数
│       │   └── browserFs.ts         # 浏览器 File System API：pickAndEnumerateFolder、readFile、writeFile
│       └── hooks/
│           └── useResizable.tsx     # 拖拽调整面板大小的分割器钩子
│
└── electron/
    ├── main.cjs                      # Electron 主进程：BrowserWindow、服务器生命周期、IPC（文件夹/文件选择器、地理位置、权限）、浏览器会话
    ├── preload.cjs                   # 预加载桥接：暴露 window.harnessDesktop（openFolder、openFile、onBrowserOpenUrl、setSitePermissions）
    ├── browser-preload.cjs           # 浏览器 webview 预加载：地理位置桥接、_blank 链接拦截
    └── native-location.cjs           # 通过 PowerShell GeoCoordinateWatcher 实现 Windows 地理位置
```

## 测试

Harness 包含一个使用 [Vitest](https://vitest.dev) 的自动化测试套件。测试涵盖所有 agent 工具、agent 循环（使用模拟的 DeepSeek API）、工具 Schema 验证和 API 端点。

### 运行测试

```powershell
# 一次性运行所有测试
npm test

# 在监视模式下运行测试（文件变更时重新运行）
npm run test:watch

# 运行测试并生成覆盖率报告
npm run test:coverage

# 运行特定测试文件
npx vitest run server/__tests__/agent.fs.test.ts
```

### 测试结构

```
server/__tests__/
├── agent.fs.test.ts          # 文件系统工具：read_file、write_file、edit_file、
│                             #   list_files、search_files、grep、create_directory、
│                             #   delete_file、rename_file、write_todos（34 个测试）
├── agent.command.test.ts     # 命令工具：run_command、run_in_terminal、
│                             #   read_command_output（19 个测试）
├── agent.loop.test.ts        # 使用模拟 DeepSeek API 响应的阻塞和流式 agent 循环
│                             #   （14 个测试）
├── agent.tooldefs.test.ts    # 工具 Schema 验证：必填字段、
│                             #   无重复名称、属性完整性（6 个测试）
└── api.test.ts               # Express 端点集成测试：健康检查、
│                             #   agent 聊天、文件系统 API、项目检测、
│                             #   系统状态（12 个测试）
```

### 测试层次

| 层 | 测试内容 | 模拟策略 |
|-------|----------|----------|
| **工具定义** | 每个工具具有有效的 JSON Schema、无重复名称、必填参数具有匹配的属性 | 无（静态验证） |
| **文件系统工具** | 每个文件系统工具的 `runFsTool()` 使用真实临时目录 | 真实文件系统 |
| **命令工具** | `run_command` 执行、阻止服务器、返回退出码；`read_command_output` 分页和过滤 | 真实 `spawn` |
| **Agent 循环** | `agentLoop()` 和 `agentLoopStream()`：工具选择逻辑、多轮循环、浏览器/授权切换、迭代限制、推理内容透传 | 模拟 DeepSeek API |
| **API 端点** | Express 路由：`/api/chat/agent`、`/api/chat/agent/stream`、`/api/health`、`/api/system/stats`、`/api/project/detect`、文件系统 CRUD、会话清理 | 模拟 DeepSeek，真实 supertest |

### 编写新测试

1. 测试使用 [Vitest](https://vitest.dev) 全局变量（`describe`、`it`、`expect`、`vi`、`beforeEach`、`afterEach`）
2. 对于 agent 循环测试，模拟 `server/deepseek.ts` 的 `chatDeepSeekTool` 或 `chatDeepSeekToolStream`，返回受控响应
3. 文件系统/命令测试使用 `runFsTool()` 配合通过 `fs.mkdtempSync()` 创建的真实临时目录
4. API 测试使用 `supertest` 针对 `server/index.ts` 导出的 `app` 进行
5. 在 `afterEach` 钩子中清理临时目录

## Token 优化（ITR + 上下文缓存 + 实时压缩）

Harness 使用四层优化来减少与 DeepSeek 通信时的 Token 使用量和 API 费用：

### 1. 指令-工具检索 (ITR)

不是在每个 agent 回合发送完整的系统提示，而是在 `server/agent.ts` 中将提示分解为 **14 个主题片段**，每个片段带有一组触发关键词。在每个回合，`buildSystemPrompt()` 仅选择与当前对话上下文相关的片段。

#### 片段注册表

每个片段是一个常量字符串，搭配一个触发关键词数组：

| 片段（ID） | 大小 | 触发关键词（部分） | 决策 |
|---|---|---|---|
| `CORE_RULES` | ~700 词 | — | 始终包含 |
| `browser` | ~400 词 | `browser_`、`DOM`、`navigate`、`click`、`type`、`form`、`modal`、`dialog`、`dropdown`、`autocomplete`、`hover` | 分数 ≥ 2，或如果任何 `browser_*` 工具已被调用则自动包含 |
| `build_fix` | ~120 词 | `build`、`compile`、`error`、`fix`、`edit_file`、`write_file`、`read_problems`、`run_command`、`syntax` | 分数 ≥ 2 |
| `lang_js` | ~200 词 | `.ts`、`.tsx`、`.js`、`.jsx`、`package.json`、`typescript`、`node`、`npm`、`react`、`vite`、`import ` | 分数 ≥ 2 |
| `lang_python` | ~250 词 | `.py`、`python`、`pip`、`flask`、`django`、`traceback`、`ModuleNotFoundError`、`uvicorn` | 分数 ≥ 2 |
| `lang_go` | ~100 词 | `.go`、`go.mod`、`go build`、`go vet`、`go test`、`go run` | 分数 ≥ 2 |
| `lang_rust` | ~100 词 | `.rs`、`cargo`、`Cargo.toml`、`rustc`、`rust`、`clippy` | 分数 ≥ 2 |
| `lang_java` | ~80 词 | `.java`、`pom.xml`、`build.gradle`、`maven`、`mvn`、`gradle`、`javac` | 分数 ≥ 2 |
| `lang_c` | ~80 词 | `.c`、`.cpp`、`.h`、`CMakeLists.txt`、`gcc`、`g++`、`cmake`、`makefile` | 分数 ≥ 2 |
| `lang_ruby` | ~80 词 | `.rb`、`Gemfile`、`ruby`、`rake`、`rspec`、`bundle`、`gem`、`rails` | 分数 ≥ 2 |
| `lang_php` | ~60 词 | `.php`、`composer.json`、`php`、`laravel`、`symfony`、`wordpress` | 分数 ≥ 2 |
| `lang_shell` | ~60 词 | `.sh`、`.bash`、`shellcheck`、`#!/bin/bash`、`bash `、`Makefile` | 分数 ≥ 2 |
| `lang_general` | ~80 词 | — | 始终包含 |
| `server_startup` | ~350 词 | `run_in_terminal`、`npm start`、`npm run dev`、`flask run`、`uvicorn`、`EADDRINUSE`、`port`、`listen` | 分数 ≥ 2 |
| `diagnostics` | ~200 词 | `run_command`、`read_problems`、`read_command_output`、`terminal`、`sandbox`、`build`、`compile`、`test`、`lint`、`error` | 分数 ≥ 2 |

完整的片段注册表及其所有触发关键词位于 [`PROMPT_CHUNKS`](file:///d:/Work Projects/Harness/server/agent.ts#L1743-L1862)。

#### 选择算法

在每个 agent 回合，[agent.ts](file:///d:/Work Projects/Harness/server/agent.ts#L1907-L1959) 中的 `buildSystemPrompt()` 运行以下流程：

```
1. 以 CORE_RULES 开始（始终存在）

2. 从以下内容构建合并文本块：
   • 所有消息内容（user、assistant、tool results）
   • 从 assistant 消息中提取的工具调用名称
   • IDE 上下文（打开的文件、诊断）

3. 对于每个可选片段：
   count = 0
   对于每个触发关键词：
       如果关键词（大小写不敏感）出现在合并文本块中：
           count += 1
   如果 count >= 2 → INCLUDE 片段
   如果 count < 2  → SKIP 片段

4. 特殊规则：如果此会话中任何 browser_* 工具已被调用，
   浏览器片段获得自动包含（boost = +5），
   无论关键词匹配如何

5. 追加 IDE 上下文页脚

6. 将选择统计记录到控制台：
   [ITR] prompt: 6142 chars (~1535 tokens) | 5 chunks selected, 9 skipped
   [ITR]   included: build_fix(s:6), lang_js(s:7), diagnostics(s:4)
   [ITR]   skipped:  browser(s:0), lang_python(s:0), lang_go(s:0), ...
```

#### 具体示例：TypeScript 项目，无浏览器交互

典型 TypeScript 回合的 `combined` 文本块包含 `.ts`、`package.json`、`typescript`、`edit_file`、`run_command`、`build`、`error`、`read_problems`、`import ` 等。

```
片段             匹配的触发器                  分数   决策
─────────────────────────────────────────────────────────────────
CORE_RULES       (始终)                       —      ✓ 包含
browser          无                            0      ✗ 跳过
build_fix        build, error, edit_file,      6      ✓ 包含
                 fix, run_command, syntax
lang_js          .ts, package.json,             7      ✓ 包含
                 typescript, import, npx,
                 tsc, react
lang_python      无                            0      ✗ 跳过
lang_go          无                            0      ✗ 跳过
lang_rust        无                            0      ✗ 跳过
lang_java        无                            0      ✗ 跳过
lang_c           无                            0      ✗ 跳过
lang_ruby        无                            0      ✗ 跳过
lang_php         无                            0      ✗ 跳过
lang_shell       无                            0      ✗ 跳过
lang_general     (始终)                       —      ✓ 包含
server_startup   无                            0      ✗ 跳过
diagnostics      run_command, read_problems,    4      ✓ 包含
                 build, test
─────────────────────────────────────────────────────────────────
结果：5 个片段包含，9 个跳过
```

**~600 词发送 vs 全部 14 个片段约 ~8,000 词 → 系统提示大小减少约 92%。**

#### 与 DeepSeek 前缀缓存的交互

因为当对话上下文稳定时（相同项目、相同语言、相同工具模式），`buildSystemPrompt()` 产生**相同的输出**，系统消息在连续回合中保持相同。DeepSeek 的服务器端 KV 缓存随后重用已缓存的前缀 Token — 因此在首次回合之后的缓存命中上系统提示**不会消耗额外的 Token**。ITR 保持提示小而稳定，使缓存命中更加频繁。

### 2. 上下文缓存

DeepSeek API 支持**自动前缀缓存**：当连续请求共享相同的前缀消息（系统消息）时，服务器重用这些 Token 的 KV 缓存 — 降低费用和延迟。

Harness 以两种方式利用这一点：

- **稳定的系统消息**：因为 `buildSystemPrompt()` 对相同上下文产生相同输出，在检测到的项目栈不变的情况下，系统消息在回合之间保持稳定。DeepSeek 对这些连续调用自动命中前缀缓存。
- **本地启发式追踪**：`server/deepseek.ts` 从系统消息内容计算上下文 ID，并根据当前系统提示哈希是否匹配上一个请求，记录一个 best-effort 的 `HIT` / `MISS` 行。
- **API 支持的缓存用量**：Harness 还读取实际的 DeepSeek `usage` 负载并提取：
  - `prompt_tokens`
  - `completion_tokens`
  - `total_tokens`
  - `prompt_cache_hit_tokens`
  - `prompt_cache_miss_tokens`

对于流式工具调用请求，`server/deepseek.ts` 启用 `stream_options.include_usage`，使最终 SSE 块包含用量数据。这会产生类似以下内容的控制台日志：

```text
[cache-api] stream model=deepseek-v4-flash prompt=1234 completion=456 total=1690 cache_hit_tokens=900 cache_miss_tokens=334 hit_rate=73%
```

重要区别：

- 旧的 `[cache] ... HIT/MISS ...` 行是基于提示哈希重用的**本地 Harness 启发式**。
- 新的 `[cache-api] ...` 行基于**实际的 DeepSeek API 用量字段**。

不需要额外的缓存控制 API 参数 — DeepSeek 在服务器端透明处理前缀缓存。

### 2b. 子 Agent 前缀缓存

每个子 agent（`delegate_task`）通常以全新的消息数组开始 — 仅系统提示和任务字符串。由于每个委托都有独特的任务，**每个子 agent 的第 1 轮都是缓存未命中**，即使重复委托相同 agent 类型（例如多个浏览器子 agent）。

为改善这一点，Harness 在父会话上存储一个**按 agent 类型共享的消息前缀**。子 agent 完成后，其任务和摘要被追加到前缀中。同一类型的下一次委托在新任务之前预置这些较早的任务/摘要对，使跨调用的 API 消息前缀相同：

```
之前（5 个浏览器子 agent，每个 3 轮）：
  子 Agent 1: [sys, task1]                  ← MISS
  子 Agent 2: [sys, task2]                  ← MISS  (task2 ≠ task1)
  子 Agent 3: [sys, task3]                  ← MISS
  → 5 次未命中（每次委托开始时）

之后（相同场景）：
  子 Agent 1: [sys, task1]                  ← MISS（首次）
  子 Agent 2: [sys, task1, summary1, task2] ← HIT on [sys, task1, summary1]
  子 Agent 3: [sys, task2, summary2, task3] ← HIT on [sys, task2, summary2]
  → 仅 1 次未命中（首次委托）
```

**存储的内容**（在 `AgentState.subAgentPrefix` 中）：

| 字段 | 内容 | 原因 |
|---|---|---|
| 键 | Agent 类型字符串（`"browser"`、`"code-writer"` 等） | 按类型隔离 — 浏览器子 agent 彼此共享，不与 code-search 共享 |
| 消息 | 最后 2 个任务/摘要对（最多 4 条消息） | 有界增长；从不存储文件内容（`read_file`/`grep` 结果），因此项目变更不会导致过期上下文 |
| 任务内容 | 截断为 500 字符 | 保持前缀紧凑 |
| 摘要内容 | 截断为 1000 字符 | 保持前缀紧凑 |

**应用位置：**
- `runSubAgentStream`（[agent.ts](server/agent.ts)）— SSE agent 循环使用的流式路径
- `runSubAgent`（[agent.ts](server/agent.ts)）— 非流式路径（researcher 任务）
- `resumeSubAgent` 不存储前缀 — 它恢复已暂停的子 agent，因此窗口不变

这是一个低风险优化：仅共享任务/摘要对，从不共享包含项目文件内容的工具结果。最坏情况是前缀中有 4 行过时的摘要行，它们作为轻量级上下文提示而非权威信息。

### 3. 滚动历史压缩

长时间运行的 agent 会话现在在构建下一个模型请求之前在服务器上压缩较早的纯文本回合。

- 仅压缩较旧的**纯聊天回合**：`user` 消息和非工具 `assistant` 回复。
- 最近的纯文本回合保持逐字，以便模型仍能看到最新的本地上下文。
- 较早的纯文本回合合并到一个有界的**历史摘要**中，存储在内存中的 agent 会话中。
- 工具调用顺序被保留：assistant 工具调用、工具结果、待定权限状态和延迟文件接受/拒绝状态作为结构化消息保留。

这意味着在长会话中，实时提示不再随每次用户/assistant 交换线性增长。

`server/agent.ts` 中的当前默认值：

| 设置 | 值 | 效果 |
|---|---|---|
| `HISTORY_COMPACTION_TRIGGER_MESSAGES` | `24` | 当内存中会话增长超过此消息数时开始压缩 |
| `HISTORY_COMPACTION_TRIGGER_TOKENS` | `10000` | 当粗略 Token 估计值跨越此阈值时也会压缩 |
| `HISTORY_PLAIN_MESSAGES_TO_KEEP` | `6` | 保持最新的纯文本回合逐字 |
| `HISTORY_SUMMARY_CHAR_BUDGET` | `2400` | 限制滚动摘要大小 |

### 4. 工具结果精简

某些工具输出远大于模型通常在下一个回合中需要的。

Harness 现在在将庞大的命令/构建输出存储回 agent 转录之前对其进行精简：

- `run_command` 存储紧凑摘要，而不是完整原始输出
- `run_in_terminal` 存储紧凑摘要（关键错误/成功行），而不是完整终端日志 — 完整输出被缓存供 `read_command_output` 使用
- `read_problems` 存储紧凑的构建检查摘要，而不是完整的编译器/linter 转储
- 摘要保留最重要的行（错误、警告、失败、URL、成功标记）
- **完整原始命令输出仍然被缓存**在命令输出存储中，并且可以通过 `read_command_output` 稍后重新阅读

这减少了大型终端/编译器日志的重复回放，同时按需保留原始输出。

### 5. 上下文 Token 估计

Agent 底部状态显示上下文用量的实时估计：`~N / M tokens (X%) · T turns`。这在服务器端每个 agent 回合计算，并通过 SSE `done` 事件发送给客户端。

当可用时，Harness 现在也会在同一 `done` 负载中发送累积的 **DeepSeek API 用量**：

- `requestCount`
- `promptTokens`
- `completionTokens`
- `totalTokens`
- `promptCacheHitTokens`
- `promptCacheMissTokens`

底部状态保持基于本地估计上下文值的环，并在 API 返回缓存用量时添加缓存状态。紧凑标签变为：

```text
X% · Tt · cYY%
```

其中 `cYY%` 是从以下公式得出的累积缓存命中率：

```text
promptCacheHitTokens / (promptCacheHitTokens + promptCacheMissTokens)
```

底部状态工具提示包括更完整的 API 总计：请求数、提示/补全/总 Token 数以及缓存命中/未命中 Token 计数。

#### 如何计算

`server/agent.ts` 中的 `estimateStateTokens()` 遍历每条消息的每个字段：

```
totalChars =
  Σ messages (
    content.length          // user 消息、assistant 回复、工具结果
    + tool_call_id.length   // 将工具调用链接到结果的 UUID
    + name.length           // 函数名（例如 "read_file"、"grep"）
    + reasoning_content?.length  // DeepSeek 思维链（R1/reasoner 模型）
  )
  + historySummary?.length  // 压缩的较早对话回合
  + systemPromptChars       // ITR 选择的提示片段（每回合计算一次）

estimatedTokens = round(totalChars / 4)
```

每个回合，`buildOpenAiMessages()` 调用 `estimateStateTokens()` 来检查 `HISTORY_COMPACTION_TRIGGER_TOKENS`（10,000）。最终估计值也通过 SSE `done` 事件发送给客户端，用于底部状态的用量环。另外，服务器在运行期间累积实际的 DeepSeek API 用量，并将这些总计附加到同一 `usage` 对象。

#### 准确性

| 因素 | 说明 |
|--------|------|
| **`chars / 4`** | 粗略启发式。DeepSeek 的字节级 BPE 分词器有所变化：代码/文本通常为 2-3 字符/Token，CJK 约 1 字符/Token。可能偏差高达 2 倍。 |
| **系统提示** | 已计入。从 ITR 片段构建（3-15K 字符 / 0.75-3.75K Token）。 |
| **`reasoning_content`** | 已计入。DeepSeek R1/reasoner 模型产生冗长的思维链。 |
| **控制台上下文** | 未计入。IDE 的诊断/终端上下文很小，单独传递用于 ITR 选择。 |
| **NOT_EXECUTED 注入** | 未计入。这些由 `buildOpenAiMessages` 在 API 调用时注入，不存储在 `state.messages` 中。 |
| **API Token 用量** | 与估计值分开。来自 DeepSeek 的 `usage` 负载，如果提供商对给定响应省略用量则可能不会出现。 |

#### 上下文限制

`contextLimit` 根据模型名称动态设置：

| 模型模式 | 上下文窗口 |
|----------|----------|
| `deepseek-chat`（V3）、`deepseek-reasoner`（R1） | 128,000 Token |
| 包含 `v4`、`pro` 或 `flash` 的模型 | 1,000,000 Token |
| 未知 / 自定义 | 128,000 Token（默认） |

#### 累积轮次

`turns` 计数器在整个会话中累积，而不是每次响应。服务器发送 `turns = iter + 1`（该 agent 回合中的迭代次数），客户端将其汇总到 `totalTurnsRef`。

### 架构

```
                ┌─────────────────────────────┐
                │    buildSystemPrompt()      │
                │  扫描消息 + 上下文           │
                │  选择相关片段                │
                └──────────────┬──────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 滚动压缩              │
                    │ + 历史摘要             │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 工具结果              │
                    │ 精简                  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 迷你系统提示           │
                    │ + 紧凑转录             │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ deepseekFetch()      │
                    │ + cacheContextId     │
                    │ → DeepSeek API       │
                    └─────────────────────┘
```

相关文件：
- `server/agent.ts` — `buildSystemPrompt()`、滚动历史压缩、工具结果精简、提示组装
- `server/deepseek.ts` — `deepseekFetch()` 带 `cacheContextId` 参数、缓存指标日志
