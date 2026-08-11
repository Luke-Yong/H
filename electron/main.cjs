const { app, BrowserWindow, ipcMain, dialog, session, webContents, nativeImage } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { getBestAvailableLocation } = require("./native-location.cjs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

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

function loadingPageHtml(title, message) {
  // Show a branded loading screen with animated "Loading..."
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
      <div class="loader-text">Loading<span class="loader-dots"></span></div>
    </div>
  </body>
</html>`;
}

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

// Use tmpdir for port files to avoid sandbox permission issues
const PORTS_DIR = path.join(require("os").tmpdir(), "h-ports");
const EXPRESS_PORT_FILE = path.join(PORTS_DIR, "express-port");
const VITE_PORT_FILE = path.join(PORTS_DIR, "vite-port");

function readPortFile(filePath) {
  try {
    const val = parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

async function waitForPortFile(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const port = readPortFile(filePath);
    if (port) return port;
    await new Promise((r) => setTimeout(r, 250));
  }
  return 0;
}

async function waitForOwnServerPort(timeoutMs) {
  const myPid = process.pid;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const port = readPortFile(EXPRESS_PORT_FILE);
    if (port) {
      try {
        const resp = await new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
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
        if (resp && resp.status >= 200 && resp.status < 500 && resp.body.pid === myPid) {
          return port;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 0;
}

function startEmbeddedServer() {
  process.env.H_DESKTOP = "1";
  process.env.H_SERVE_CLIENT = "1";
  if (process.resourcesPath && process.platform === "win32") {
    process.env.ESBUILD_BINARY_PATH = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@esbuild",
      "win32-x64",
      "esbuild.exe"
    );
  }

  const tsx = require("tsx/cjs/api");
  const api = tsx.register({ namespace: "h-electron" });
  api.require(path.join(__dirname, "..", "server", "index.ts"), __filename);
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
    const expressPort = await waitForOwnServerPort(30_000);
    if (!expressPort) {
      const failHtml = loadingPageHtml("H", "Express server failed to start.");
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    serverPort = expressPort;

    // Express ready — find Vite dev server
    const vitePort = await waitForPortFile(VITE_PORT_FILE, 120_000);
    if (!vitePort) {
      const failHtml = loadingPageHtml("H", "Vite dev server failed to start.");
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    await loadUrlWhenReady(
      win,
      `http://localhost:${vitePort}`,
      `http://localhost:${vitePort}`,
      10_000,
      "H"
    );
    win.show();
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const port = await waitForOwnServerPort(30_000);
    if (!port) {
      const failHtml = loadingPageHtml("H", "Express server failed to start.");
      win.loadURL(`data:text/html;base64,${Buffer.from(failHtml, "utf8").toString("base64")}`);
      win.show();
      return;
    }
    serverPort = port;
    await loadUrlWhenReady(
      win,
      `http://127.0.0.1:${port}`,
      `http://127.0.0.1:${port}/api/health`,
      2_000,
      "H"
    );
    win.show();
  }
}

// Must be set before app.whenReady() on Windows to apply the taskbar icon
app.setAppUserModelId("com.h.ide.v1");

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

// Clean up stale files from previous runs
try { fs.unlinkSync(EXPRESS_PORT_FILE); } catch {}
try { fs.unlinkSync(VITE_PORT_FILE); } catch {}
try {
  const portsDir = path.dirname(EXPRESS_PORT_FILE);
  if (fs.existsSync(portsDir)) {
    for (const f of fs.readdirSync(portsDir)) {
      try { fs.unlinkSync(path.join(portsDir, f)); } catch {}
    }
  }
} catch {}

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

// Clean up port files and PID lock on exit
app.on("before-quit", () => {
  releasePidLock();
  try { fs.unlinkSync(EXPRESS_PORT_FILE); } catch {}
  try { fs.unlinkSync(VITE_PORT_FILE); } catch {}
});
process.on("exit", () => {
  releasePidLock();
  try { fs.unlinkSync(EXPRESS_PORT_FILE); } catch {}
  try { fs.unlinkSync(VITE_PORT_FILE); } catch {}
});

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
