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

## How it works

1. Write HTML/CSS/JS in the Monaco Editor
2. Click **Run Test** — code gets injected into a Playwright browser
3. The DOM is extracted and sent to DeepSeek with your test goal
4. DeepSeek returns actions (click/type) which Playwright executes
5. Results and screenshots stream back in real-time
