import "dotenv/config";
import express from "express";
import { createServer } from "http";
import http from "http";
import https from "https";
import { WebSocketServer, WebSocket } from "ws";
import { launchBrowser, closeBrowser } from "./browser";
import { runLoop, LoopConfig, LoopEvent } from "./loop";
import { chatDeepSeek } from "./deepseek";
import {
  createSession, writeToSession, resizeSession,
  killSession, killAllInGroup,
} from "./terminalManager";
import fs from "fs";
import path from "path";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3001;

app.use(express.json({ limit: "10mb" }));

// ── Broadcast helper ──
const broadcast = (event: LoopEvent | { type: string; data: unknown }) => {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
};

// ── Test run ──
app.post("/api/run", async (req, res) => {
  const config: LoopConfig = req.body;
  if (!config.html && !config.goal) {
    return res.status(400).json({ error: "Missing html, css, js or goal" });
  }

  res.json({ status: "started" });

  try {
    await launchBrowser();
    await runLoop(config, broadcast);
  } catch (err) {
    broadcast({ type: "error", data: String(err) });
  }
});

// ── Agentic coding chat ──
app.post("/api/chat", async (req, res) => {
  const { message, context, history } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });

  try {
    broadcast({ type: "log", data: `User: ${message}` });
    const reply = await chatDeepSeek(message, context || "", history || []);
    broadcast({ type: "assistant", data: reply });
    res.json({ reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    res.status(500).json({ error: msg });
  }
});

// ── File system API ──
function safePath(userPath: string): string {
  const resolved = path.resolve(userPath);
  // Basic safety: don't allow going above root drive for now
  return resolved;
}

app.get("/api/fs/list", (req, res) => {
  try {
    const dirPath = safePath((req.query.path as string) || process.cwd());
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: dirPath, entries: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/fs/read", (req, res) => {
  try {
    const filePath = safePath(req.query.path as string);
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Project detection (venv / node_modules/.bin) ──
app.get("/api/project/detect", (req, res) => {
  try {
    const basePath = safePath((req.query.path as string) || process.cwd());
    const isWin = process.platform === "win32";

    const venvCandidates = [".venv", "venv", "env", ".env"];
    let venvDir: string | null = null;
    let activateScript: string | null = null;
    let pythonInterpreter: string | null = null;

    for (const name of venvCandidates) {
      const dir = path.join(basePath, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }

      venvDir = name;
      if (isWin) {
        const act = path.join(dir, "Scripts", "Activate.ps1");
        const py = path.join(dir, "Scripts", "python.exe");
        activateScript = fs.existsSync(act) ? act : null;
        pythonInterpreter = fs.existsSync(py) ? py : null;
      } else {
        const act = path.join(dir, "bin", "activate");
        const py = path.join(dir, "bin", "python");
        activateScript = fs.existsSync(act) ? act : null;
        pythonInterpreter = fs.existsSync(py) ? py : null;
      }
      break;
    }

    const nodeBinDir = path.join(basePath, "node_modules", ".bin");
    const hasNodeBin = (() => {
      try {
        return fs.statSync(nodeBinDir).isDirectory();
      } catch {
        return false;
      }
    })();

    res.json({
      basePath,
      isWin,
      venvDir,
      activateScript,
      pythonInterpreter,
      nodeBinDir: hasNodeBin ? nodeBinDir : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/fs/write", (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: "Missing path or content" });
    fs.writeFileSync(safePath(filePath), content, "utf-8");
    broadcast({ type: "log", data: `Saved: ${path.basename(filePath)}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/fs/mkdir", (req, res) => {
  try {
    const dirPath = safePath(req.body.path);
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/fs/create-file", (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: "Missing path" });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(safePath(filePath), content || "", "utf-8");
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Health check ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Serve client (desktop / production) ──
const clientDist = path.resolve(process.cwd(), "client", "dist");
if (process.env.HARNESS_SERVE_CLIENT === "1" && fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/|ws\/?|_browser\/?).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// ── Browser reverse proxy (universal — all URLs proxied for same-origin iframe access) ──

// Reverse proxy – /_browser?url=<encoded_url>
// Proxies any URL through the Harness server so the iframe is always same-origin.
// This enables click interception, title/URL sync, and _blank link handling for all sites.
app.use("/_browser", (req, res, next) => {
  const encoded = typeof req.query.url === "string" ? req.query.url : "";
  if (!encoded) return next();

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(encoded);
  } catch {
    return res.status(400).send("Invalid URL encoding");
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return res.status(400).send("Only http/https URLs supported");
    }
  } catch {
    return res.status(400).send("Invalid URL");
  }

  // Build the actual path from the proxied request (strip /_browser and query)
  const proxyPath = req.url.includes("?") ? "" : req.url.slice("/_browser".length) || "/";

  const client = parsed.protocol === "https:" ? https : http;

  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: parsed.host,
        referer: undefined as any,
      },
    },
    (proxyRes) => {
      const headers: Record<string, string | string[] | undefined> = {
        ...proxyRes.headers,
      };
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];

      // Inject <base> tag for HTML responses so relative URLs resolve correctly
      const contentType = String(headers["content-type"] || "");
      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        delete headers["content-length"]; // will change due to injection
        let body = "";
        proxyRes.setEncoding("utf8");
        proxyRes.on("data", (chunk: string) => { body += chunk; });
        proxyRes.on("end", () => {
          const baseTag = `<base href="${targetUrl.replace(/"/g, "&quot;")}">`;
          const injected = body.replace(/<head[^>]*>/i, (match) => match + baseTag);
          res.writeHead(proxyRes.statusCode || 200, headers);
          res.end(injected);
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on("error", (err) => {
    console.error(`[BrowserProxy] Error for ${targetUrl}: ${err.message}`);
    if (!res.headersSent) res.status(502).send("Proxy error");
  });

  req.pipe(proxyReq);
});

// Fallback: unrecognized /_browser path
app.use("/_browser", (_req, res) => {
  res.status(400).send("Usage: /_browser?url=<encoded_url>");
});

// ── WebSocket ──
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");
  ws.send(JSON.stringify({ type: "log", data: "Connected to Harness server" }));

  const activeSessions = new Set<string>();
  let groupKey: string | null = null;

  ws.on("message", (raw) => {
    const msg = raw.toString();

    if (msg.startsWith("term:create:")) {
      // term:create:groupKey:cwdEncoded:venvDirEncoded?:activateScriptEncoded?
      const parts = msg.slice(12).split(":");
      const nextGroupKey = parts[0] || "";
      const cwd = parts[1] ? decodeURIComponent(parts[1]) : undefined;
      const venvDir = parts[2] ? decodeURIComponent(parts[2]) : undefined;
      const activateScript = parts[3] ? decodeURIComponent(parts[3]) : undefined;
      groupKey = nextGroupKey;
      const id = createSession(ws, groupKey, { cwd, venvDir, activateScript });
      activeSessions.add(id);

    } else if (msg.startsWith("term:write:")) {
      // term:write:sessionId:data
      const rest = msg.slice(11);
      const idx = rest.indexOf(":");
      if (idx === -1) return;
      const sid = rest.slice(0, idx);
      const data = rest.slice(idx + 1);
      if (groupKey) writeToSession(groupKey, sid, data);

    } else if (msg.startsWith("term:resize:")) {
      // term:resize:sessionId:cols:rows
      const parts = msg.slice(12).split(":");
      if (parts.length >= 3) {
        const sid = parts[0];
        const cols = parseInt(parts[1]) || 80;
        const rows = parseInt(parts[2]) || 24;
        if (groupKey) resizeSession(groupKey, sid, cols, rows);
      }

    } else if (msg.startsWith("term:kill:")) {
      // term:kill:sessionId
      const sid = msg.slice(10);
      if (groupKey) {
        killSession(groupKey, sid);
        activeSessions.delete(sid);
      }
    }
  });

  ws.on("close", () => {
    if (groupKey) killAllInGroup(groupKey);
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Harness server running on http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit();
});
process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit();
});
