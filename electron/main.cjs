process.title = "H";

const { app, BrowserWindow, ipcMain, dialog, session, webContents, nativeImage } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { getBestAvailableLocation } = require("./native-location.cjs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Must be set before any Chromium initialization so child processes inherit the name on Windows
app.setAppUserModelId("com.h.ide.v1");
app.name = "H";

const H_BROWSER_PARTITION = "h-browser";
const sitePermissions = new Map();
const LOCATION_REFRESH_INTERVAL_MS = 300_000; // 5 min – Windows location polling is heavier
const LOCATION_FRESH_MS = 330_000;             // cache valid 5.5 min
let cachedLocation = null;
let cachedLocationUpdatedAt = 0;
let locationRefreshPromise = null;
let locationRefreshTimer = null;
const geoOverrideDebounce = new Map();

function showFatalStartupError(error) {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  try { console.error("[h-startup]", message); } catch {}
  try { dialog.showErrorBox("H failed to start", message); } catch {}
}

process.on("unhandledRejection", (error) => {
  showFatalStartupError(error);
});

process.on("uncaughtException", (error) => {
  showFatalStartupError(error);
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadingPageHtml(title, message, detail) {
  // Show a branded loading screen with animated "Loading..."
  const detailBlock = detail ? `<div class="loader-detail">${escapeHtml(detail)}</div>` : "";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        background: #1e1e1e;
        color: #ddd;
        user-select: none;
        -webkit-app-region: drag;
      }
      .loader {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
      }
      .loader-icon {
        width: 64px;
        height: 64px;
      }
      .loader-text {
        font-size: 16px;
        color: #9aa0a6;
        letter-spacing: 0.5px;
        white-space: pre-wrap;
        text-align: center;
        max-width: 720px;
        line-height: 1.5;
      }
      .loader-detail {
        margin-top: 8px;
        font-size: 13px;
        color: #7a7f85;
        white-space: pre-wrap;
        text-align: left;
        max-width: 720px;
        line-height: 1.55;
        background: #262626;
        border: 1px solid #3a3a3a;
        padding: 12px 16px;
        border-radius: 6px;
        max-height: 320px;
        overflow-y: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      .loader-dots::after {
        content: "";
        animation: dots 1.5s steps(4, end) infinite;
      }
      @keyframes dots {
        0%   { content: ""; }
        25%  { content: "."; }
        50%  { content: ".."; }
        75%  { content: "..."; }
      }
    </style>
  </head>
  <body>
    <div class="loader">
      <svg class="loader-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="2" width="5.5" height="20" rx="2.75" fill="#4D6BFE"/><rect x="15.5" y="2" width="5.5" height="20" rx="2.75" fill="#4D6BFE"/><rect x="3" y="9.5" width="18" height="5" rx="2.5" fill="#4D6BFE"/>
      </svg>
      <div class="loader-text">${escapeHtml(message)}</div>
      ${detailBlock}
    </div>
  </body>
</html>`;
}

const net = require("net");
const EXPRESS_DEFAULT_PORT = 51734;
const EXPRESS_PORT_RANGE = 20;

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs ?? 200);
    let resolved = false;
    const done = (open) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroy(); } catch {}
      resolve(open);
    };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
    sock.on("close", () => done(false));
    try { sock.connect(port, host); } catch { done(false); }
  });
}

let parsedServerPort = 0;
let serverLastExit = null;          // { code, signal } if child has exited
let serverTailLog = "";             // rolling 8KB tail of child stdout+stderr for diagnostics
const SERVER_TAIL_MAX = 8192;

function requestOk(url) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(800, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await requestOk(url);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ── Fixed port discovery (no files) ──
// Primary: parse stdout for "H server running on http://localhost:PORT"
// Secondary: probe the fixed port range

async function findLiveServerPort(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Early exit: server process crashed; no point probing for 60s.
    if (serverLastExit && !serverChildProcess) {
      const code = serverLastExit.code;
      const tail = serverTailLog.trim();
      const hint = tail ? `\n\nServer output tail:\n${tail}` : "";
      throw new Error(
        `Server process exited prematurely with code ${code ?? "<null>"}${hint}`
      );
    }
    // 1. Prefer stdout-parsed port if we got it
    if (parsedServerPort > 0) {
      const alive = await probePort("127.0.0.1", parsedServerPort, 200);
      if (alive) {
        // Also verify the health endpoint responds
        try {
          const resp = await new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${parsedServerPort}/api/health`, (res) => {
              let body = "";
              res.on("data", (chunk) => { body += chunk; });
              res.on("end", () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch { resolve(null); }
              });
            });
            req.on("error", () => resolve(null));
            req.setTimeout(800, () => { req.destroy(); resolve(null); });
          });
          if (resp && resp.status >= 200 && resp.status < 500 && resp.body && resp.body.pid > 0) {
            return parsedServerPort;
          }
        } catch {}
      }
    }
    // 2. Probe port range sequentially
    for (let i = 0; i < EXPRESS_PORT_RANGE; i++) {
      const p = EXPRESS_DEFAULT_PORT + i;
      const open = await probePort("127.0.0.1", p, 150);
      if (!open) continue;
      try {
        const resp = await new Promise((resolve) => {
          const req = http.get(`http://127.0.0.1:${p}/api/health`, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
              try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
              catch { resolve(null); }
            });
          });
          req.on("error", () => resolve(null));
          req.setTimeout(500, () => { req.destroy(); resolve(null); });
        });
        if (resp && resp.status >= 200 && resp.status < 500 && resp.body && resp.body.pid > 0) {
          return p;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

// Use tmpdir for port file only for VITE dev server port (written by vite plugin)
const PORTS_DIR = path.join(require("os").tmpdir(), "h-ports");
const VITE_PORT_FILE = path.join(PORTS_DIR, "vite-port");

function readPortFile(filePath) {
  try {
    const val = parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

let serverChildProcess = null;

function resolveProjectRoot() {
  // main.cjs lives at <root>/electron/main.cjs; project root is one level up
  return path.resolve(__dirname, "..");
}

function startEmbeddedServer() {
  const { spawn } = require("child_process");
  process.env.H_DESKTOP = "1";
  process.env.H_SERVE_CLIENT = "1";
  parsedServerPort = 0;

  // Only set ESBUILD_BINARY_PATH in packaged builds where app.asar.unpacked exists.
  // In dev mode, esbuild finds its own binary in node_modules.
  if (process.resourcesPath && process.platform === "win32") {
    const esbuildPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@esbuild",
      "win32-x64",
      "esbuild.exe"
    );
    if (fs.existsSync(esbuildPath)) {
      process.env.ESBUILD_BINARY_PATH = esbuildPath;
    }
  }

  const isDev = !app.isPackaged;
  const projectRoot = resolveProjectRoot();

  let cmd;
  let args = [];
  const serverEnv = { ...process.env };

  if (isDev) {
    // Dev mode: run tsx via node loader, avoiding any shell (which would split
    // arguments at spaces in project paths like "D:\Work Projects\Harness").
    //
    // process.execPath here is electron.exe (desktop:dev invokes the Electron binary).
    // Set ELECTRON_RUN_AS_NODE=1 so the child initialises as a plain Node interpreter
    // (not a Chromium renderer host) and can run the generic tsx CLI .mjs entrypoint.
    //
    // Invoking <exe> <tsx-cli.mjs> <target.ts> with all absolute paths means the
    // argv array is passed straight through to the child — no quoting / tokenization.
    serverEnv.ELECTRON_RUN_AS_NODE = "1";
    const serverPath = path.join(projectRoot, "server", "index.ts");
    const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    cmd = process.execPath;
    args = [tsxCli, serverPath];
  } else {
    // Packaged mode: MUST run the pre-compiled CommonJS server
    // (desktop:build-server step produces dist/server/index.js). tsx has been moved
    // to devDependencies and is not bundled in the installer, so there is no
    // fallback transpile path — the build step must have run.
    const compiledServer = path.join(projectRoot, "dist", "server", "index.js");
    if (!fs.existsSync(compiledServer)) {
      const errMsg =
        `[h-startup] FATAL: compiled server not found at ${compiledServer}.\n` +
        `  Run 'npm run desktop:build-server' before packaging, or re-run 'npm run desktop:pack'.`;
      console.error(errMsg);
      if (typeof dialog !== "undefined") {
        dialog.showErrorBox("H could not start", errMsg);
      }
      throw new Error(errMsg);
    }
    serverEnv.ELECTRON_RUN_AS_NODE = "1";
    cmd = process.execPath;
    args = [compiledServer];

    // Ensure native modules (better-sqlite3, node-pty, @esbuild/win32-x64) are
    // resolved from the *unpacked* folder inside the installer. Electron asar's
    // patched require walks asar first by default; if the package.json/main lands
    // in asar and the package's `build/Release/*.node` is in asar.unpacked,
    // relative requires from within asar resolve incorrectly on Windows.
    // Prepending NODE_PATH forces `require("better-sqlite3")` to check
    // app.asar.unpacked/node_modules before any asar-relative resolution.
    if (process.resourcesPath) {
      const unpackedNodeModules = path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules"
      );
      if (fs.existsSync(unpackedNodeModules)) {
        serverEnv.NODE_PATH = serverEnv.NODE_PATH
          ? `${unpackedNodeModules}${path.delimiter}${serverEnv.NODE_PATH}`
          : unpackedNodeModules;
      }
    }
  }

  // CRITICAL: never enable shell — it re-tokenizes arguments at spaces which breaks
  // project paths containing spaces ("D:\Work Projects\..."). All argument arrays
  // above are already resolved to absolute paths and pass directly to the child.
  //
  // Also explicitly set the child CWD to the app root. On fresh installations the
  // inherited CWD can be the user's home, the desktop, or the installer exe dir,
  // which changes what relative require()/readFile() inside the server resolve to.
  const spawnOpts = {
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    cwd: app.getAppPath ? app.getAppPath() : projectRoot,
  };

  console.log(`[h-startup] spawning: cmd=${cmd}`);
  console.log(`[h-startup] args: ${args.map((a) => `"${a}"`).join(" ")}`);
  console.log(`[h-startup] cwd:  ${spawnOpts.cwd}`);
  if (spawnOpts.env && spawnOpts.env.NODE_PATH) {
    console.log(`[h-startup] NODE_PATH: ${spawnOpts.env.NODE_PATH}`);
  }

  // Reset state from previous runs.
  serverLastExit = null;
  serverTailLog = "";
  serverChildProcess = spawn(cmd, args, spawnOpts);

  // ── Parse port from server stdout + forward logs ──
  // Regex matches: H server running on http://localhost:<PORT>
  const portRegex = /H server running on http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;
  const _origLog = console.log.bind(console);
  const _origErr = console.error.bind(console);

  const appendTail = (text) => {
    serverTailLog = (serverTailLog + text).slice(-SERVER_TAIL_MAX);
  };

  const onStdout = (chunk) => {
    const text = chunk.toString ? chunk.toString("utf8") : String(chunk);
    appendTail(text);
    if (!parsedServerPort) {
      const m = portRegex.exec(text);
      if (m && m[1]) {
        const p = parseInt(m[1], 10);
        if (p > 0) { parsedServerPort = p; }
      }
    }
    try { process.stdout.write(chunk); } catch {}
    if (isDev) {
      try { _origLog(String(text).replace(/\r?\n$/, "")); } catch {}
    }
  };
  const onStderr = (chunk) => {
    const text = chunk.toString ? chunk.toString("utf8") : String(chunk);
    appendTail(text);
    if (!parsedServerPort) {
      const m = portRegex.exec(text);
      if (m && m[1]) {
        const p = parseInt(m[1], 10);
        if (p > 0) { parsedServerPort = p; }
      }
    }
    try { process.stderr.write(chunk); } catch {}
    if (isDev) {
      try { _origErr(String(text).replace(/\r?\n$/, "")); } catch {}
    }
  };

  serverChildProcess.stdout?.on("data", onStdout);
  serverChildProcess.stderr?.on("data", onStderr);

  serverChildProcess.on("error", (err) => {
    appendTail(`[electron] spawn error: ${err && err.message ? err.message : String(err)}\n`);
    console.error("[h-startup] Server process error:", err.message);
  });

  serverChildProcess.on("exit", (code, signal) => {
    serverLastExit = { code, signal };
    console.log("[h-startup] Server process exited with code", code, signal ? `signal ${signal}` : "");
    if (code !== 0 && code !== null) {
      console.error("[h-startup] Server stderr/stdout tail:\n" + serverTailLog);
    }
    serverChildProcess = null;
  });
}

function normalizeOrigin(rawUrl) {
  try {
    const origin = new URL(rawUrl).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

function emitBrowserOpenUrl(contents, targetUrl) {
  const ownerContents = contents.hostWebContents || contents;
  if (!ownerContents || ownerContents.isDestroyed()) return;
  ownerContents.send("h:browserOpenUrl", targetUrl);
}

function resolvePermissionOrigin(requestingOrigin, details) {
  return (
    normalizeOrigin(requestingOrigin) ||
    normalizeOrigin(details?.requestingUrl) ||
    normalizeOrigin(details?.embeddingOrigin) ||
    ""
  );
}

function isPermissionEnabled(requestingOrigin, permission, details) {
  const origin = resolvePermissionOrigin(requestingOrigin, details);
  if (!origin) return false;

  const allowed = sitePermissions.get(origin);
  if (!allowed) return false;

  switch (permission) {
    case "geolocation":
      return allowed.has("geolocation");
    case "midi":
    case "midiSysex":
      return allowed.has("midi");
    case "media": {
      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const needsCamera = mediaTypes.includes("video");
      const needsMicrophone = mediaTypes.includes("audio");
      if (needsCamera && !allowed.has("camera")) return false;
      if (needsMicrophone && !allowed.has("microphone")) return false;
      return needsCamera || needsMicrophone;
    }
    default:
      return false;
  }
}

function scheduleGeolocationOverride(contents, reason) {
  if (!isBrowserContents(contents)) return;
  const key = contents.id;
  const prev = geoOverrideDebounce.get(key);
  if (prev) clearTimeout(prev);
  geoOverrideDebounce.set(
    key,
    setTimeout(() => {
      geoOverrideDebounce.delete(key);
      void ensureGeolocationOverride(contents, reason);
    }, 50)
  );
}

function setupBrowserSession() {
  const browserSession = getBrowserSession();

  browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const allowed = isPermissionEnabled(requestingOrigin, permission, details);
    if (allowed && permission === "geolocation") {
      scheduleGeolocationOverride(webContents, "permission-check");
    }
    return allowed;
  });

  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = isPermissionEnabled(details?.requestingUrl, permission, details);
    if (allowed && permission === "geolocation") {
      scheduleGeolocationOverride(webContents, "permission-request");
    }
    callback(allowed);
  });
}

function attachPopupInterception(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url && url !== "about:blank") {
      emitBrowserOpenUrl(contents, url);
    }
    return { action: "deny" };
  });
}

function getBrowserSession() {
  return session.fromPartition(H_BROWSER_PARTITION);
}

function isBrowserContents(contents) {
  try {
    return contents && !contents.isDestroyed() && contents.session === getBrowserSession();
  } catch {
    return false;
  }
}

function getAllBrowserContents() {
  const browserSession = getBrowserSession();
  return webContents.getAllWebContents().filter((c) => {
    try {
      return c && !c.isDestroyed() && c.session === browserSession;
    } catch {
      return false;
    }
  });
}

async function ensureGeolocationOverride(contents, reason = "") {
  if (!isBrowserContents(contents)) return;

  const currentUrl = contents.getURL?.() || "";
  const origin = normalizeOrigin(currentUrl);

  let loc = cachedLocation;
  if (!loc?.ok) {
    loc = await getIdeWideLocation(35_000);
  }
  if (!loc?.ok) {
    return;
  }

  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
  } catch (err) {
    return;
  }

  try {
    await contents.debugger.sendCommand("Emulation.setGeolocationOverride", {
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude),
      accuracy: Math.max(1, Number(loc.accuracy || 100)),
    });
  } catch (err) {
  }
}

async function refreshSharedLocation(reason, timeoutMs) {
  if (locationRefreshPromise) return locationRefreshPromise;

  locationRefreshPromise = (async () => {
    const result = await getBestAvailableLocation(timeoutMs);
    if (result?.ok) {
      cachedLocation = result;
      cachedLocationUpdatedAt = Date.now();
    }
    if (result?.ok) {
      for (const contents of getAllBrowserContents()) {
        void ensureGeolocationOverride(contents);
      }
    }
    return result;
  })().finally(() => {
    locationRefreshPromise = null;
  });

  return locationRefreshPromise;
}

function ensureSharedLocationLoop() {
  if (locationRefreshTimer) return;
  locationRefreshTimer = setInterval(() => {
    void refreshSharedLocation("interval", 35_000);
}, LOCATION_REFRESH_INTERVAL_MS);
  if (typeof locationRefreshTimer.unref === "function") {
    locationRefreshTimer.unref();
  }
}

async function getIdeWideLocation(timeoutMs) {
  ensureSharedLocationLoop();

  if (cachedLocation?.ok && Date.now() - cachedLocationUpdatedAt <= LOCATION_FRESH_MS) {
    return cachedLocation;
  }

  const result = await refreshSharedLocation("ipc-request", timeoutMs);
  if (result?.ok) return result;

  if (cachedLocation?.ok) {
    return cachedLocation;
  }

  return result;
}

// ── Resource Monitor Window ──
let resourceMonitorWindow = null;
let serverPort = 0;

function getStandaloneUrl(pagePath) {
  const isDev = process.env.ELECTRON_DEV === "1";
  if (isDev) {
    const vitePort = readPortFile(VITE_PORT_FILE);
    if (vitePort) return `http://localhost:${vitePort}${pagePath}`;
  }
  return `http://127.0.0.1:${serverPort}${pagePath}`;
}

function openResourceMonitorWindow(parentWin) {
  if (resourceMonitorWindow && !resourceMonitorWindow.isDestroyed()) {
    resourceMonitorWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 900,
    height: 550,
    backgroundColor: "#1e1e1e",
    title: "System Resources",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.webContents.on("did-finish-load", () => {
    console.log("[resource-monitor] Page loaded successfully");
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDesc, validatedURL) => {
    console.log("[resource-monitor] Load failed:", errorCode, errorDesc, validatedURL);
  });
  win.loadURL(getStandaloneUrl("/resources"));

  win.on("closed", () => {
    resourceMonitorWindow = null;
  });

  resourceMonitorWindow = win;
}

function closeResourceMonitorWindow() {
  if (resourceMonitorWindow && !resourceMonitorWindow.isDestroyed()) {
    resourceMonitorWindow.close();
    resourceMonitorWindow = null;
  }
}

// ── Settings Window ──
let settingsWindow = null;

function openSettingsWindow(parentWin) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 700,
    height: 600,
    backgroundColor: "#1e1e1e",
    title: "Settings",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.webContents.on("did-fail-load", (_event, errorCode, errorDesc, validatedURL) => {
    console.log("[settings] Load failed:", errorCode, errorDesc, validatedURL);
  });
  win.loadURL(getStandaloneUrl("/settings"));

  win.on("closed", () => {
    settingsWindow = null;
  });

  settingsWindow = win;
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    settingsWindow = null;
  }
}

function registerIpc() {
  ipcMain.on("h:getBrowserPreloadUrl", (event) => {
    event.returnValue = `file:///${path.join(__dirname, "browser-preload.cjs").replace(/\\/g, "/")}`;
  });

  // Last opened folder tracking — for defaulting dialog to parent
  const LAST_FOLDER_FILE = path.join(app.getPath("userData"), "last-folder.json");
  function loadLastFolder() {
    try {
      if (fs.existsSync(LAST_FOLDER_FILE)) {
        const data = JSON.parse(fs.readFileSync(LAST_FOLDER_FILE, "utf8"));
        if (typeof data.path === "string" && data.path) return data.path;
      }
    } catch {}
    return null;
  }
  function saveLastFolder(folderPath) {
    try {
      fs.writeFileSync(LAST_FOLDER_FILE, JSON.stringify({ path: folderPath }));
    } catch {}
  }

  ipcMain.handle("h:openFolder", async () => {
    const lastFolder = loadLastFolder();
    const defaultPath = lastFolder ? path.dirname(lastFolder) : undefined;
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      defaultPath,
    });
    if (result.canceled) return "";
    const chosen = result.filePaths?.[0] || "";
    if (chosen) saveLastFolder(chosen);
    return chosen;
  });

  ipcMain.handle("h:openFile", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled) return "";
    return result.filePaths?.[0] || "";
  });

  ipcMain.handle("h:setSitePermissions", async (_event, payload) => {
    const origin = normalizeOrigin(payload?.origin);
    if (!origin) return false;

    const next = new Set();
    const permissions = payload?.permissions || {};
    for (const [key, enabled] of Object.entries(permissions)) {
      if (enabled) next.add(key);
    }
    sitePermissions.set(origin, next);
    for (const contents of getAllBrowserContents()) {
      void ensureGeolocationOverride(contents);
    }
    return true;
  });

  ipcMain.handle("h:getNativeLocation", async (event, payload) => {
    const senderUrl = event.sender?.getURL?.() || "";
    const senderOrigin = normalizeOrigin(senderUrl);
    const allowed = isPermissionEnabled(senderOrigin, "geolocation", {
      requestingUrl: senderUrl,
      requestingOrigin: senderOrigin,
    });

    if (!allowed) {
      return {
        ok: false,
        code: 1,
        message: "Location permission is blocked for this site.",
      };
    }

    const timeoutMs = Math.max(30_000, Number(payload?.options?.timeout) || 35_000);
    const result = await getIdeWideLocation(timeoutMs);
    return result;
  });

  ipcMain.on("h:openResourceMonitor", (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    openResourceMonitorWindow(parentWin);
  });

  ipcMain.on("h:closeResourceMonitor", () => {
    closeResourceMonitorWindow();
  });

  ipcMain.on("h:openSettings", (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    openSettingsWindow(parentWin);
  });

  ipcMain.on("h:closeSettings", () => {
    closeSettingsWindow();
  });

  // Window controls for frameless window
  ipcMain.on("h:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on("h:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.on("h:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("h:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  // New Window
  ipcMain.on("h:newWindow", () => {
    createMainWindow();
  });
}

async function loadUrlWhenReady(win, targetUrl, healthUrl, timeoutMs, title) {
  // Use base64 data URL to avoid ERR_FAILED (-2) from large encodeURIComponent strings
  const html = loadingPageHtml(title, `Waiting for ${healthUrl}...`);
  const dataUrl = `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
  await win.loadURL(dataUrl);

  const ok = await waitForUrl(healthUrl, timeoutMs);
  if (!ok) {
    const failHtml = loadingPageHtml(title, `Timed out waiting for ${healthUrl}.`);
    const failUrl = `data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`;
    await win.loadURL(failUrl);
    return false;
  }

  await win.loadURL(targetUrl);
  return true;
}

async function waitForVitePort(timeoutMs) {
  // Vite plugin writes VITE_PORT_FILE — prefer that, fall back to probing common Vite range
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = readPortFile(VITE_PORT_FILE);
    if (p > 0) {
      const ok = await requestOk(`http://localhost:${p}/`);
      if (ok) return p;
    }
    // Fallback: probe default Vite ports 5173..5180
    for (let i = 5173; i < 5181; i++) {
      const alive = await probePort("127.0.0.1", i, 100);
      if (alive) return i;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 0;
}

async function createMainWindow() {
  const isDev = process.env.ELECTRON_DEV === "1";

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    frame: false,
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true,
    },
  });

  win.setMenuBarVisibility(false);

  // Force taskbar icon refresh — Windows caches by AppUserModelID
  try {
    win.setIcon(nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.ico")));
  } catch (_) { /* non-fatal */ }

  win.on("closed", () => {
    closeSettingsWindow();
    closeResourceMonitorWindow();
  });

  attachPopupInterception(win.webContents);

  // Fast path: server is already running (subsequent windows)
  if (serverPort > 0) {
    if (isDev) {
      const vitePort = readPortFile(VITE_PORT_FILE);
      if (vitePort) {
        win.loadURL(`http://localhost:${vitePort}`);
        win.show();
        win.webContents.openDevTools({ mode: "detach" });
        return;
      }
    } else {
      win.loadURL(`http://127.0.0.1:${serverPort}`);
      win.show();
      return;
    }
  }

  if (isDev) {
    // Use longer timeout because tsx watch + tsc typechecking can be slow on cold start
    let expressPort = 0;
    try {
      expressPort = await findLiveServerPort(60_000);
    } catch (startupErr) {
      const reason = startupErr instanceof Error ? startupErr.message : String(startupErr);
      console.error("[h-startup] Dev server startup failed:", reason);
      const failHtml = loadingPageHtml(
        "H",
        `Dev server failed to start.\n\n${reason}`,
        serverTailLog || "Check the terminal for more details."
      );
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    if (!expressPort) {
      const failHtml = loadingPageHtml("H", "Express server failed to start. Check logs for errors.", serverTailLog);
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    serverPort = expressPort;

    // Express ready — find Vite dev server
    const vitePort = await waitForVitePort(120_000);
    if (!vitePort) {
      const failHtml = loadingPageHtml("H", "Vite dev server failed to start. Check logs for errors.");
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    await loadUrlWhenReady(
      win,
      `http://localhost:${vitePort}`,
      `http://localhost:${vitePort}`,
      15_000,
      "H"
    );
    win.show();
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Packaged: find server via fixed range + stdout parsed port.
    // Use generous timeout because compiled JS should start fast, but on
    // slower machines antivirus scans can delay the process.
    let port = 0;
    try {
      port = await findLiveServerPort(60_000);
    } catch (startupErr) {
      const reason = startupErr instanceof Error ? startupErr.message : String(startupErr);
      console.error("[h-startup] Packaged server startup failed:", reason);
      try {
        dialog.showErrorBox(
          "H could not start",
          reason + (serverTailLog ? `\n\nDiagnostic log:\n${serverTailLog}` : "")
        );
      } catch {}
      const failHtml = loadingPageHtml(
        "H",
        `H could not start:\n\n${reason}`,
        serverTailLog || "No server logs captured."
      );
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    if (!port) {
      const failHtml = loadingPageHtml("H", "H server failed to start. Please try launching again.");
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    serverPort = port;
    await loadUrlWhenReady(
      win,
      `http://127.0.0.1:${port}`,
      `http://127.0.0.1:${port}/api/health`,
      10_000,
      "H"
    );
    win.show();
  }
}

// ── Dynamic window title ──
ipcMain.on("h:setTitle", (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && title) {
    win.setTitle(title);
    // On Windows, setting the title also updates the taskbar entry label
    if (process.platform === "win32") {
      win.setAppDetails?.({ appId: "com.h.ide.v1" });
    }
  }
});

// ── Custom single-instance lock (PID-file based) ──
// Electron's requestSingleInstanceLock() is unreliable on Windows (ACCESS_DENIED).
// We use a PID file to track the running instance.
const PID_FILE = path.join(require("os").tmpdir(), "h-pid");

function isProcessAlive(pid) {
  try {
    // On Windows: use tasklist to check if PID exists
    const { execSync } = require("child_process");
    execSync(`tasklist /FI "PID eq ${pid}" 2>nul | findstr "${pid}"`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function acquirePidLock() {
  try {
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(PID_FILE)) {
      const raw = fs.readFileSync(PID_FILE, "utf8").trim();
      const stalePid = parseInt(raw, 10);
      if (stalePid > 0 && isProcessAlive(stalePid)) {
        return false; // Another instance is running
      }
      // Stale lock — remove it
      try { fs.unlinkSync(PID_FILE); } catch {}
    }

    fs.writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch {
    return true; // If we can't check, allow startup
  }
}

function releasePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const raw = fs.readFileSync(PID_FILE, "utf8").trim();
      const pid = parseInt(raw, 10);
      if (pid === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {}
}

// NOTE: No stale express port file to clean — server uses fixed port range now.
// vite-port is written by Vite plugin (which starts before Electron) — keep it for dev mode.

const gotTheLock = acquirePidLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Focus the existing window instead of creating a new one
    const existingWin = BrowserWindow.getAllWindows()[0];
    if (existingWin) {
      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.focus();
    }
  });
}

// Clean up PID lock, server process, and Vite port file on exit
function cleanup() {
  releasePidLock();
  if (serverChildProcess) { try { serverChildProcess.kill(); } catch {} }
  try { fs.unlinkSync(VITE_PORT_FILE); } catch {}
}
app.on("before-quit", cleanup);
process.on("exit", cleanup);

app.whenReady().then(async () => {
  registerIpc();
  setupBrowserSession();
  ensureSharedLocationLoop();
  void refreshSharedLocation("startup", 35_000);
  startEmbeddedServer();

  app.on("web-contents-created", (_event, contents) => {
    attachPopupInterception(contents);
    if (!isBrowserContents(contents)) return;
    const apply = () => void ensureGeolocationOverride(contents);
    const applySoon = () => setTimeout(apply, 0);
    applySoon();
    contents.on("did-start-navigation", applySoon);
    contents.on("did-finish-load", apply);
    contents.on("did-navigate", apply);
    contents.on("did-navigate-in-page", apply);
    try {
      contents.debugger.on("detach", (_event, reason) => {
        scheduleGeolocationOverride(contents, "debugger-detach");
      });
    } catch {}
    contents.on("destroyed", () => {
      try {
        if (contents.debugger && contents.debugger.isAttached()) {
          contents.debugger.detach();
        }
      } catch {}
    });
  });

  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
