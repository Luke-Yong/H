const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const http = require("http");
const path = require("path");

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

function registerIpc() {
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
    },
  });

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
  startEmbeddedServer();
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
