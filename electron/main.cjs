const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const http = require("http");
const path = require("path");
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

function reportDebugMain(hypothesisId, location, msg, data) {
  fetch("http://127.0.0.1:7777/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "desktop-browser-crash",
      runId: "post-fix",
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {});
}

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

function isPermissionEnabled(requestingOrigin, permission, details) {
  const origin =
    normalizeOrigin(requestingOrigin) ||
    normalizeOrigin(details?.requestingUrl) ||
    normalizeOrigin(details?.embeddingOrigin);
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

function setupBrowserSession() {
  const browserSession = session.fromPartition(HARNESS_BROWSER_PARTITION);

  browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const allowed = isPermissionEnabled(requestingOrigin, permission, details);
    reportDebugMain("D", "electron/main.cjs:permissionCheck", "permission check", {
      permission,
      requestingOrigin,
      requestingUrl: details?.requestingUrl,
      embeddingOrigin: details?.embeddingOrigin,
      allowed,
    });
    return allowed;
  });

  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = isPermissionEnabled(details?.requestingOrigin, permission, details);
    reportDebugMain("D", "electron/main.cjs:permissionRequest", "permission request", {
      permission,
      requestingOrigin: details?.requestingOrigin,
      requestingUrl: details?.requestingUrl,
      embeddingOrigin: details?.embeddingOrigin,
      mediaTypes: details?.mediaTypes,
      allowed,
    });
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

async function refreshSharedLocation(reason, timeoutMs) {
  if (locationRefreshPromise) return locationRefreshPromise;

  locationRefreshPromise = (async () => {
    const result = await getBestAvailableLocation(timeoutMs);
    if (result?.ok) {
      cachedLocation = result;
      cachedLocationUpdatedAt = Date.now();
    }
    reportDebugMain("D", "electron/main.cjs:sharedLocation", "shared location refresh finished", {
      reason,
      ok: !!result?.ok,
      provider: result?.provider,
      code: result?.code,
      message: result?.message,
      usedCachedFallback: !!(!result?.ok && cachedLocation?.ok),
    });
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
    reportDebugMain("D", "electron/main.cjs:sharedLocation", "shared location cache hit", {
      provider: cachedLocation.provider,
      ageMs: Date.now() - cachedLocationUpdatedAt,
    });
    return cachedLocation;
  }

  const result = await refreshSharedLocation("ipc-request", timeoutMs);
  if (result?.ok) return result;

  if (cachedLocation?.ok) {
    reportDebugMain("D", "electron/main.cjs:sharedLocation", "using stale cached location after refresh failure", {
      provider: cachedLocation.provider,
      ageMs: Date.now() - cachedLocationUpdatedAt,
      code: result?.code,
      message: result?.message,
    });
    return cachedLocation;
  }

  return result;
}

function registerIpc() {
  ipcMain.on("harness:getBrowserPreloadUrl", (event) => {
    event.returnValue = `file:///${path.join(__dirname, "browser-preload.cjs").replace(/\\/g, "/")}`;
  });

  ipcMain.handle("harness:openFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled) return "";
    return result.filePaths?.[0] || "";
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
    reportDebugMain("D", "electron/main.cjs:setSitePermissions", "stored site permissions", {
      origin,
      permissions: Array.from(next.values()),
    });
    return true;
  });

  ipcMain.handle("harness:getNativeLocation", async (event, payload) => {
    const senderUrl = event.sender?.getURL?.() || "";
    const senderOrigin = normalizeOrigin(senderUrl);
    const allowed = isPermissionEnabled(senderOrigin, "geolocation", {
      requestingUrl: senderUrl,
      requestingOrigin: senderOrigin,
    });

    reportDebugMain("D", "electron/main.cjs:getNativeLocation", "native location request", {
      senderUrl,
      senderOrigin,
      allowed,
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
    reportDebugMain("D", "electron/main.cjs:getNativeLocation", "native location result", {
      senderOrigin,
      ok: !!result?.ok,
      provider: result?.provider,
      code: result?.code,
      message: result?.message,
    });
    return result;
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
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true,
    },
  });

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
