const { app, BrowserWindow, ipcMain, dialog, session, webContents } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { getBestAvailableLocation } = require("./native-location.cjs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const HARNESS_BROWSER_PARTITION = "harness-browser";
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
  try { console.error("[harness-startup]", message); } catch {}
  try { dialog.showErrorBox("Harness failed to start", message); } catch {}
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
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #1e1e1e; color: #ddd; }
      .wrap { padding: 28px; }
      h1 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
      p { margin: 6px 0; color: #bdbdbd; }
      code, pre { background: #111; border: 1px solid #333; border-radius: 6px; padding: 10px 12px; display: block; overflow: auto; }
      .hint { margin-top: 12px; color: #9aa0a6; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="hint">This window will continue trying in the background.</div>
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

function startEmbeddedServer() {
  process.env.HARNESS_DESKTOP = "1";
  process.env.HARNESS_SERVE_CLIENT = "1";
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
  const api = tsx.register({ namespace: "harness-electron" });
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
  ownerContents.send("harness:browserOpenUrl", targetUrl);
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
  return session.fromPartition(HARNESS_BROWSER_PARTITION);
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
  win.loadURL("http://127.0.0.1:3001/resources");

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

function registerIpc() {
  ipcMain.on("harness:getBrowserPreloadUrl", (event) => {
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

  ipcMain.handle("harness:openFolder", async () => {
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

  ipcMain.handle("harness:openFile", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled) return "";
    return result.filePaths?.[0] || "";
  });

  ipcMain.handle("harness:setSitePermissions", async (_event, payload) => {
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

  ipcMain.handle("harness:getNativeLocation", async (event, payload) => {
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

  ipcMain.on("harness:openResourceMonitor", (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    openResourceMonitorWindow(parentWin);
  });

  ipcMain.on("harness:closeResourceMonitor", () => {
    closeResourceMonitorWindow();
  });

  // Window controls for frameless window
  ipcMain.on("harness:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on("harness:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.on("harness:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("harness:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}

async function loadUrlWhenReady(win, targetUrl, healthUrl, timeoutMs, title) {
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    loadingPageHtml(title, `Waiting for ${healthUrl}...`)
  )}`;
  await win.loadURL(dataUrl);

  const ok = await waitForUrl(healthUrl, timeoutMs);
  if (!ok) {
    const failUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
      loadingPageHtml(title, `Timed out waiting for ${healthUrl}.`)
    )}`;
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
    frame: false,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true,
    },
  });

  win.setMenuBarVisibility(false);

  attachPopupInterception(win.webContents);

  if (isDev) {
    await loadUrlWhenReady(
      win,
      "data:text/html;charset=utf-8," + encodeURIComponent(loadingPageHtml("Starting Harness server", "Server is ready.")),
      "http://127.0.0.1:3001/api/health",
      30_000,
      "Starting Harness server"
    );
  } else {
    await loadUrlWhenReady(
      win,
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3001/api/health",
      30_000,
      "Starting Harness"
    );
  }

  if (isDev) {
    await loadUrlWhenReady(
      win,
      "http://localhost:5173",
      "http://localhost:5173",
      120_000,
      "Starting Harness UI"
    );
    win.webContents.openDevTools({ mode: "detach" });
  }
}

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
