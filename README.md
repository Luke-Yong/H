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

## How it works

1. Write HTML/CSS/JS in the Monaco Editor
2. Click **Run Test** — code gets injected into a Playwright browser
3. The DOM is extracted and sent to DeepSeek with your test goal
4. DeepSeek returns actions (click/type) which Playwright executes
5. Results and screenshots stream back in real-time
