import "dotenv/config";
import express from "express";
import { createServer } from "http";
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
  app.get(/^\/(?!api\/|ws\/?).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// ── WebSocket ──
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");
  ws.send(JSON.stringify({ type: "log", data: "Connected to Harness server" }));

  const activeSessions = new Set<string>();
  let groupKey: string | null = null;

  ws.on("message", (raw) => {
    const msg = raw.toString();

    if (msg.startsWith("term:create:")) {
      // term:create:groupKey:cwdEncoded?
      const rest = msg.slice(12);
      const firstSep = rest.indexOf(":");
      const nextGroupKey = firstSep === -1 ? rest : rest.slice(0, firstSep);
      const cwdEncoded = firstSep === -1 ? "" : rest.slice(firstSep + 1);
      const cwd = cwdEncoded ? decodeURIComponent(cwdEncoded) : undefined;
      groupKey = nextGroupKey;
      const id = createSession(ws, groupKey, { cwd });
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
