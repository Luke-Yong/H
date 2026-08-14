# Contributing to H

Thanks for your interest in contributing. H is an **agent-native AI coding agent** — an Electron desktop app backed by a Node.js server, powered by DeepSeek. This file covers how to set up a dev environment, run tests, and submit changes.

## Code of conduct

Be respectful and assume good intent. Keep discussions technical and focused on the code.

## Prerequisites

- **Node.js 18+** and **npm**
- A **DeepSeek API key** — get one at [platform.deepseek.com](https://platform.deepseek.com)
- Git

Native modules (`better-sqlite3`, `node-pty`) are rebuilt automatically during install via the root `postinstall` script.

## Development setup

```powershell
git clone https://github.com/Luke-Yong/H.git
cd H
npm run install:all
npm run dev
```

- `npm run install:all` installs the root and client dependencies (and triggers the native-module rebuild).
- `npm run dev` starts the server (tsx watch) and the client (Vite) together.

Individual processes:

```powershell
npm run dev:server   # Node/Express + WebSocket server only
npm run dev:client   # React/Vite client only
```

## Project structure

| Path | Purpose |
|---|---|
| `client/` | React 18 + Vite + Monaco Editor + xterm.js UI |
| `server/` | Node.js + Express + WebSocket server, agent loop, tools, memory, knowledge graph, LSP, MCP |
| `electron/` | Desktop shell (main process, preloads) |
| `scripts/` | Build/icon helpers |
| `build/` | Icons and installer hooks |

The agent loop, the 27 tools, and the sub-agent delegation logic live in `server/agent.ts`. The knowledge graph builder is in `server/knowledgeGraph.ts`, and the MCP server is in `server/mcp.ts`.

## Testing

Tests use [Vitest](https://vitest.dev/) and run against the server in a Node environment:

```powershell
npm run test            # run once
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
```

Tests live in `server/**/*.test.ts` (see `server/__tests__/`). Add or update a test for any behavior change.

## TypeScript & build

The server is TypeScript compiled to CommonJS; the client is a Vite + React app.

```powershell
npm run desktop:build        # build the client (tsc + vite build)
npm run desktop:build-server # compile the server to dist/
npm run desktop:pack         # package a Windows installer (electron-builder)
```

Run a TypeScript check before submitting:

```powershell
npx tsc -p tsconfig.json --noEmit  # server
cd client && npx tsc --noEmit      # client
```

## Code style

- Prefer built-in solutions over new dependencies.
- Write defensive code around data boundaries (API responses, filesystem, user input); don't add speculative error handling for cases that cannot happen internally.
- Declare variables before use and avoid relying on hoisting or declaration order to be correct.
- Keep comments for the *why*, not the *what*.
- Follow the existing style in the file you're editing.

## Making a change

1. Open an issue first for non-trivial changes so the approach can be discussed.
2. Create a branch off `main`.
3. Make focused, minimal changes. One logical change per PR.
4. Add/update tests and run `npm run test`.
5. Run the TypeScript checks above.
6. Push and open a pull request with a clear description of **what** and **why**.

Do not commit secrets or `.env` files — they are git-ignored.

## Reporting issues

Include:

- H version and OS
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs

For agent behavior, note the model used and, where possible, the failing tool call or sub-agent.

## License

H is licensed under **AGPL-3.0**. By contributing, you agree that your contributions are licensed under the same terms.
