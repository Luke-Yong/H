import "dotenv/config";
import express from "express";
import { createServer } from "http";
import http from "http";
import https from "https";
import { WebSocketServer, WebSocket } from "ws";
import { chatDeepSeek } from "./deepseek";
import {
  createSession, writeToSession, resizeSession,
  killSession, killAllInGroup, setLastWsGroupKey, getLastWsGroupKey, getLastCreatedSessionId,
} from "./terminalManager";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execSync } from "child_process";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

export { app };

const PORT = 3001;

app.use(express.json({ limit: "10mb" }));

const CLIENT_API_KEY_COOKIE = "harness_api_session";
const clientApiKeySessions = new Map<string, { apiKey: string; updatedAt: number }>();

// ── Persistent API key storage (~/.harness/api-keys.json) ──
const API_KEYS_DIR = path.join(os.homedir(), ".harness");
const API_KEYS_FILE = path.join(API_KEYS_DIR, "api-keys.json");

function loadApiKeys(): void {
  try {
    if (!fs.existsSync(API_KEYS_FILE)) return;
    const raw = fs.readFileSync(API_KEYS_FILE, "utf-8");
    const entries: [string, { apiKey: string; updatedAt: number }][] = JSON.parse(raw);
    for (const [token, session] of entries) {
      clientApiKeySessions.set(token, session);
    }
  } catch { /* ignore corrupt/missing file */ }
}

function saveApiKeys(): void {
  try {
    if (!fs.existsSync(API_KEYS_DIR)) fs.mkdirSync(API_KEYS_DIR, { recursive: true });
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify([...clientApiKeySessions.entries()], null, 2), "utf-8");
  } catch { /* ignore write errors */ }
}

// Load persisted keys on startup
loadApiKeys();

function parseCookies(req: express.Request): Record<string, string> {
  const raw = req.headers.cookie || "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function getClientApiKeyToken(req: express.Request): string | null {
  const cookies = parseCookies(req);
  const token = cookies[CLIENT_API_KEY_COOKIE];
  return token || null;
}

function getEffectiveApiKey(req: express.Request): { apiKey: string | null; source: "session" | "none"; sessionToken?: string } {
  const token = getClientApiKeyToken(req);
  if (token) {
    const session = clientApiKeySessions.get(token);
    if (session?.apiKey) {
      session.updatedAt = Date.now();
      return { apiKey: session.apiKey, source: "session", sessionToken: token };
    }
  }
  return { apiKey: null, source: "none" };
}

function shouldUseSecureCookie(req: express.Request): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

// ── Broadcast helper ──
const broadcast = (event: { type: string; data: unknown }) => {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
};

// Forward server console.log to renderer DevTools via WebSocket
const _origLog = console.log;
const shouldWriteServerStdout = process.env.HARNESS_DESKTOP !== "1";
console.log = (...args: any[]) => {
  if (shouldWriteServerStdout) {
    try {
      _origLog(...args);
    } catch {}
  }
  try {
    broadcast({ type: "server_log", data: args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") });
  } catch {}
};

// ── Agentic coding chat (simple, single-turn) ──
app.post("/api/chat", async (req, res) => {
  const { message, context, history } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    broadcast({ type: "log", data: `User: ${message}` });
    const reply = await chatDeepSeek(message, context || "", history || [], apiKey);
    broadcast({ type: "assistant", data: reply });
    res.json({ reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    res.status(500).json({ error: msg });
  }
});

// ── Agentic chat (tool-calling loop) ──
import { createAgentSession, getAgentSession, addToolResult, addToolResultStream, deleteAgentSession, agentLoop, agentLoopStream, agentLoopStepByStep, runFsTool, storeCommandOutput, summarizeCommandResult, resumeSubAgent, type AgentState, type AgentResponse, type AgentSseEvent } from "./agent";

app.post("/api/chat/agent", async (req, res) => {
  const { message, context, projectRoot, model, sessionId: clientSessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing message" });
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    broadcast({ type: "log", data: `User (agent): ${message}` });
    const root = projectRoot || process.cwd();
    const sessionId = typeof clientSessionId === "string" && clientSessionId
      ? clientSessionId
      : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state = createAgentSession(sessionId, root, message, context || "");

    const result = await agentLoop(root, state, context || "", { model, apiKey });

    if (result.phase === "tool_needed") {
      broadcast({ type: "agent_tool", data: { sessionId, tool: result.tool, executedTools: result.executedTools } });
      res.json({
        phase: "tool_needed",
        sessionId,
        tool: result.tool,
        executedTools: result.executedTools,
        messages: result.messages,
      });
    } else {
      broadcast({ type: "assistant", data: result.reply });
      res.json({ phase: "done", reply: result.reply, messages: result.messages });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    res.status(500).json({ error: msg });
  }
});

app.post("/api/chat/agent/continue", async (req, res) => {
  const { sessionId, toolCallId, toolResult, projectRoot, model } = req.body || {};
  if (!sessionId || !toolCallId || toolResult === undefined) {
    return res.status(400).json({ error: "Missing sessionId, toolCallId, or toolResult" });
  }
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    const state = getAgentSession(sessionId);
    if (!state) return res.status(404).json({ error: "Session not found" });

    // ── Sub-agent resume: if a sub-agent was paused waiting for a browser tool ──
    if (state.pendingSubAgent) {
      const psa = state.pendingSubAgent;
      state.pendingSubAgent = undefined;
      const subResult = await resumeSubAgent(
        psa.subState, psa.config, toolCallId, String(toolResult),
        { model, apiKey },
      );
      if (subResult.phase === "browser_tool") {
        // Sub-agent needs another browser tool — re-store and yield again
        state.pendingSubAgent = {
          ...psa,
          subState: subResult.subState,
        };
        broadcast({ type: "agent_tool", data: { sessionId, tool: { name: subResult.toolName, id: subResult.toolCallId, params: subResult.params }, executedTools: [] } });
        return res.json({
          phase: "tool_needed",
          sessionId,
          tool: { name: subResult.toolName, id: subResult.toolCallId, params: subResult.params },
          executedTools: [],
          messages: state.messages,
        });
      }
      // Sub-agent done — push delegate_task result to parent state
      const resultText = `[${psa.config.name}] Completed in ${subResult.iterations} turns.\n${subResult.summary}`;
      state.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: psa.parentToolCallId, type: "function", function: { name: "delegate_task", arguments: psa.parentToolArgs } }]),
        name: "delegate_task",
        ...(psa.parentReasoning ? { reasoning_content: psa.parentReasoning } : {}),
      });
      state.messages.push({ role: "tool", content: resultText, tool_call_id: psa.parentToolCallId });
      // Continue the parent agent loop
      broadcast({ type: "agent_tool_result", data: { sessionId, toolCallId: psa.parentToolCallId, toolResult: resultText.slice(0, 500) } });
      const result = await agentLoop(projectRoot || state.projectRoot, state, "", { model, apiKey });
      if (result.phase === "tool_needed") {
        broadcast({ type: "agent_tool", data: { sessionId, tool: result.tool, executedTools: result.executedTools } });
        return res.json({ phase: "tool_needed", sessionId, tool: result.tool, executedTools: result.executedTools, messages: result.messages });
      }
      broadcast({ type: "assistant", data: result.reply });
      return res.json({ phase: "done", reply: result.reply, messages: result.messages });
    }

    addToolResult(sessionId, toolCallId, String(toolResult));
    broadcast({ type: "agent_tool_result", data: { sessionId, toolCallId, toolResult: String(toolResult).slice(0, 500) } });

    const result = await agentLoop(projectRoot || state.projectRoot, state, "", { model, apiKey });

    if (result.phase === "tool_needed") {
      broadcast({ type: "agent_tool", data: { sessionId, tool: result.tool, executedTools: result.executedTools } });
      res.json({
        phase: "tool_needed",
        sessionId,
        tool: result.tool,
        executedTools: result.executedTools,
        messages: result.messages,
      });
    } else {
      broadcast({ type: "assistant", data: result.reply });
      res.json({ phase: "done", reply: result.reply, messages: result.messages });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    res.status(500).json({ error: msg });
  }
});

// ── Streaming agent (SSE) ──
// The client opens an SSE connection, receives progressive events,
// and may need to call /continue/stream when a browser tool is needed.

app.post("/api/chat/agent/stream", async (req, res) => {
  const { message, context, projectRoot, model, thinking, sessionId: clientSessionId } = req.body || {};
  const effectiveModel = model || "deepseek-chat";
  if (!message) return res.status(400).json({ error: "Missing message" });
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    broadcast({ type: "log", data: `User (agent): ${message}` });
    const root = projectRoot || process.cwd();
    const sessionId = typeof clientSessionId === "string" && clientSessionId
      ? clientSessionId
      : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state = createAgentSession(sessionId, root, message, context || "");

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: AgentSseEvent) => {
      const data = JSON.stringify({ ...event, sessionId });
      res.write(`data: ${data}\n\n`);
    };

    const modelOpts = { model: effectiveModel, apiKey };
    for await (const event of agentLoopStream(root, state, context || "", sessionId, modelOpts)) {
      sendEvent(event);
      if (event.type === "browser_tool" || event.type === "permission_required" || event.type === "done" || event.type === "error") break;
    }

    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
      res.end();
    }
  }
});

// ── Step-by-Step Agent Streaming (IDE-Driven Todo Execution) ──
// The agent first creates a plan (write_todos only), then the IDE locks the
// todo list and forces the agent through each step one at a time via sub-agents.

app.post("/api/chat/agent/stream/stepbystep", async (req, res) => {
  const { message, context, projectRoot, model, sessionId: clientSessionId } = req.body || {};
  const effectiveModel = model || "deepseek-chat";
  if (!message) return res.status(400).json({ error: "Missing message" });
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    broadcast({ type: "log", data: `User (step-by-step): ${message}` });
    const root = projectRoot || process.cwd();
    const sessionId = typeof clientSessionId === "string" && clientSessionId
      ? clientSessionId
      : `agent-sbs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state = createAgentSession(sessionId, root, message, context || "");

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: AgentSseEvent) => {
      const data = JSON.stringify({ ...event, sessionId });
      res.write(`data: ${data}\n\n`);
    };

    const modelOpts = { model: effectiveModel, apiKey };
    for await (const event of agentLoopStepByStep(root, state, context || "", sessionId, modelOpts)) {
      sendEvent(event);
      if (event.type === "done" || event.type === "error") break;
    }

    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
      res.end();
    }
  }
});

app.post("/api/chat/agent/stream/continue", async (req, res) => {
  const { sessionId, toolCallId, toolResult, permissionGranted, model, thinking, consoleContext } = req.body || {};
  const effectiveModel = model || "deepseek-chat";
  if (!sessionId || !toolCallId) {
    return res.status(400).json({ error: "Missing sessionId or toolCallId" });
  }
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    const state = getAgentSession(sessionId);
    if (!state) return res.status(404).json({ error: "Session not found" });

    // ── Step 1: Handle deferred file tool Accept/Reject ──
    // File tools auto-execute and yield "Diff ready". The second /continue call
    // carries Accept ("OK") or Reject ("rejected") from the user.
    let cmdResult: string | null = null;
    let permissionToolName: string | undefined = undefined;
    let permissionToolParams: Record<string, unknown> | undefined;
    let statePushed = false; // skip generic push when already pushed (e.g. summarized terminal output)
    
    // ── Sub-agent resume (streaming): check before normal flow ──
    if (state.pendingSubAgent && !state.deferredTool && !(state.pendingPermission && state.pendingPermission.toolCallId === toolCallId)) {
      const psa = state.pendingSubAgent;
      state.pendingSubAgent = undefined;
      const subResult = await resumeSubAgent(
        psa.subState, psa.config, toolCallId, String(toolResult),
        { model: effectiveModel, apiKey },
      );
      if (subResult.phase === "browser_tool") {
        state.pendingSubAgent = { ...psa, subState: subResult.subState };
        broadcast({ type: "agent_tool", data: { sessionId, tool: { name: subResult.toolName, id: subResult.toolCallId, params: subResult.params }, executedTools: [] } });
        // Return SSE so the frontend can parse the event and continue with the correct toolCallId
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`data: ${JSON.stringify({
          type: "browser_tool",
          toolName: subResult.toolName,
          toolCallId: subResult.toolCallId,
          toolParams: subResult.params,
          subAgentParentToolCallId: psa.parentToolCallId,
          agentMarker: psa.agentType,
          isSubAgent: true,
          sessionId,
        })}\n\n`);
        res.end();
        return;
      }
      // Sub-agent done — push delegate_task result to parent state and continue
      const resultText = `[${psa.config.name}] Completed in ${subResult.iterations} turns.\n${subResult.summary}`;
      state.messages.push({
        role: "assistant",
        content: JSON.stringify([{ id: psa.parentToolCallId, type: "function", function: { name: "delegate_task", arguments: psa.parentToolArgs } }]),
        name: "delegate_task",
        ...(psa.parentReasoning ? { reasoning_content: psa.parentReasoning } : {}),
      });
      state.messages.push({ role: "tool", content: resultText, tool_call_id: psa.parentToolCallId });
      broadcast({ type: "agent_tool_result", data: { sessionId, toolCallId: psa.parentToolCallId, toolResult: resultText.slice(0, 500) } });

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sendEvent = (event: AgentSseEvent) => {
        res.write(`data: ${JSON.stringify({ ...event, sessionId })}\n\n`);
      };
      sendEvent({ type: "tool_end", toolName: "delegate_task", toolResult: resultText, toolParams: {},
        subAgentName: psa.config.name,
        subAgentMessages: subResult.subState.messages.map((m: any) => ({
          role: m.role, content: m.content || "", name: m.name, reasoning_content: m.reasoning_content,
        })),
      } as AgentSseEvent);
      const continueContext = typeof consoleContext === "string" ? consoleContext : "";
      for await (const event of agentLoopStream(state.projectRoot, state, continueContext, sessionId, { model: effectiveModel, apiKey })) {
        sendEvent(event);
        if (event.type === "browser_tool" || event.type === "done" || event.type === "error") break;
      }
      return res.end();
    }

    if (state.deferredTool && state.deferredTool.toolCallId === toolCallId) {
      const dt = state.deferredTool;
      state.deferredTool = undefined;
      const accepted = String(toolResult || "").toLowerCase() !== "rejected";
      if (accepted) {
        state.messages.push({ role: "tool", content: dt.result, tool_call_id: dt.toolCallId });
      } else {
        // Rejected — revert to original content (only edit_file is deferred now)
        if (dt.originalContent != null && dt.filePath) {
          try {
            const resolvedPath = path.resolve(state.projectRoot, dt.filePath);
            fs.writeFileSync(resolvedPath, dt.originalContent, "utf-8");
          } catch { /* best effort */ }
        }
        state.messages.push({ role: "tool", content: "Rejected by user.", tool_call_id: dt.toolCallId });
      }
      cmdResult = accepted ? dt.result : "Rejected by user.";
    } else if (state.pendingPermission && state.pendingPermission.toolCallId === toolCallId) {
      // ── Step 1 alternative: Handle permission Allow/Deny (run_in_terminal) ──
      const pp = state.pendingPermission;
      permissionToolName = pp.toolName;
      permissionToolParams = pp.params;
      state.pendingPermission = undefined;

      if (permissionGranted) {
        if (pp.toolName === "browser_eval") {
          cmdResult = String(toolResult || "Executed.");
        } else {
          // run_in_terminal: use frontend-provided terminal output as tool result if available
          const termOut = typeof toolResult === "string" && toolResult.trim() ? toolResult : null;
          if (termOut) {
            const seq = storeCommandOutput(pp.command, termOut);
            const rawResult = `[cmd #${seq}] ${termOut}`;
            // Push summarized version to model context (save tokens on long logs);
            // the full output is in commandOutputStore for read_command_output.
            state.messages.push({ role: "tool", content: summarizeCommandResult(rawResult, "Terminal output"), tool_call_id: pp.toolCallId });
            cmdResult = rawResult; // full output for SSE tool_end display
            statePushed = true;
          } else {
            cmdResult = `${pp.command} is starting in a terminal tab. The terminal may auto-detect a URL and open a browser tab shortly. Call browser_info to check if a tab opened — do NOT guess the port.`;
          }
          // Track this terminal session for kill_terminal
          const termSessionId = getLastCreatedSessionId();
          const termGroupKey = getLastWsGroupKey();
          if (termSessionId && termGroupKey) {
            if (!state.agentTerminalSessions) state.agentTerminalSessions = [];
            state.agentTerminalSessions.push({ sessionId: termSessionId, groupKey: termGroupKey, command: pp.command });
          }
        }
      } else {
        cmdResult = "Permission denied by user.";
      }
      if (cmdResult !== null && !statePushed) {
        state.messages.push({ role: "tool", content: cmdResult, tool_call_id: pp.toolCallId });
      }
    } else {
      // Browser tool result (or other non-permission continue)
      addToolResultStream(sessionId, toolCallId, String(toolResult || ""));
    }
    broadcast({ type: "agent_tool_result", data: { sessionId, toolCallId, toolResult: String(toolResult || cmdResult || "").slice(0, 500) } });

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: AgentSseEvent) => {
      res.write(`data: ${JSON.stringify({ ...event, sessionId })}\n\n`);
    };

    // Yield tool_end for permission-gated tools (run_in_terminal)
    if (cmdResult !== null && !state.deferredTool) {
      const termSandbox = typeof toolResult === "string" && toolResult.trim() ? toolResult : undefined;
      sendEvent({
        type: "tool_end",
        toolName: permissionToolName || "run_in_terminal",
        toolResult: cmdResult,
        toolParams: permissionToolParams,
      } as AgentSseEvent);
    }

    const continueContext = typeof consoleContext === "string" ? consoleContext : "";
    for await (const event of agentLoopStream(state.projectRoot, state, continueContext, sessionId, { model: effectiveModel, apiKey })) {
      sendEvent(event);
      if (event.type === "browser_tool" || event.type === "done" || event.type === "error") break;
    }

    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", data: msg });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
      res.end();
    }
  }
});

app.post("/api/chat/agent/credentials", (req, res) => {
  const apiKey = String(req.body?.apiKey || "").trim();
  if (!apiKey) return res.status(400).json({ error: "Missing API key" });

  const existingToken = getClientApiKeyToken(req);
  const token = existingToken || crypto.randomBytes(24).toString("hex");
  clientApiKeySessions.set(token, { apiKey, updatedAt: Date.now() });
  saveApiKeys();
  res.cookie(CLIENT_API_KEY_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(req),
    path: "/",
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year — cookie persists alongside the file-backed key
  });
  res.json({ ok: true, apiKeyConfigured: true, source: "session" });
});

app.delete("/api/chat/agent/credentials", (req, res) => {
  const token = getClientApiKeyToken(req);
  if (token) {
    clientApiKeySessions.delete(token);
    saveApiKeys();
  }
  res.clearCookie(CLIENT_API_KEY_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(req),
    path: "/",
  });
  // After clearing, the client has no key.
  res.json({
    ok: true,
    apiKeyConfigured: false,
    source: "none" as const,
  });
});

app.get("/api/chat/agent/config", (req, res) => {
  const { apiKey, source } = getEffectiveApiKey(req);
  res.json({
    apiKeyConfigured: Boolean(apiKey),
    source,
    modelDefault: "deepseek-chat",
  });
});

// ── Clear agent session by thread ID ──
app.delete("/api/chat/agent/sessions/:threadId", (req, res) => {
  try {
    deleteAgentSession(req.params.threadId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.options("/api/chat/agent/sessions/:threadId", (_req, res) => { res.sendStatus(204); });

// ── File system API ──
function safePath(userPath: string): string {
  if (!userPath || !String(userPath).trim()) {
    throw Object.assign(new Error("Missing path"), { code: "EINVAL" });
  }
  const resolved = path.resolve(userPath);
  // Basic safety: don't allow going above root drive for now
  return resolved;
}

function statusForFsError(err: any): number {
  const code = err?.code;
  if (code === "ENOENT") return 404;
  if (code === "EINVAL") return 400;
  if (code === "EACCES" || code === "EPERM") return 403;
  return 500;
}

function readFileResilient(resolved: string): Buffer {
  const delays = [0, 40, 120, 250];
  let lastErr: any;
  for (const wait of delays) {
    if (wait) {
      const until = Date.now() + wait;
      while (Date.now() < until) { /* brief sync backoff for Windows rename/lock races */ }
    }
    try {
      return fs.readFileSync(resolved);
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      if (code !== "ENOENT" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
    }
  }
  throw lastErr;
}

// Write a file, tolerating transient Windows lock errors (EPERM/EACCES/EBUSY)
// caused by antivirus scans, cloud sync, or auto-reload dev servers briefly
// holding the file. Clears any read-only attribute and retries with backoff.
async function writeFileResilient(resolved: string, content: string): Promise<void> {
  const delays = [0, 60, 150, 300, 600];
  let lastErr: any;
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      fs.writeFileSync(resolved, content, "utf-8");
      return;
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
      // Read-only attribute? Clear it before the next attempt.
      if ((code === "EPERM" || code === "EACCES") && fs.existsSync(resolved)) {
        try { fs.chmodSync(resolved, 0o666); } catch { /* */ }
      }
    }
  }
  throw lastErr;
}

app.get("/api/fs/list", (req, res) => {
  try {
    const dirPath = safePath((req.query.path as string) || process.cwd());
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = entries
      .filter((e) => e.name !== "node_modules")
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
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      res.status(404).json({ error: "Path not found" });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// Recursively list ALL files under a directory (flat array of paths).
app.get("/api/fs/list-recursive", (req, res) => {
  try {
    const dirPath = safePath((req.query.path as string) || process.cwd());
    const result: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          result.push(full);
        }
      }
    };
    walk(dirPath);
    res.json({ path: dirPath, files: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/fs/read", (req, res) => {
  try {
    const filePath = safePath(req.query.path as string);
    const raw = readFileResilient(filePath);
    try {
      const { content, encoding } = detectAndDecode(raw);
      res.json({ path: filePath, content, encoding });
    } catch {
      // Fallback: return as base64 for binary/unreadable files
      res.json({ path: filePath, content: "", encoding: "binary", base64: raw.toString("base64") });
    }
  } catch (err) {
    res.status(statusForFsError(err)).json({ error: String(err), code: (err as any)?.code || "UNKNOWN" });
  }
});

app.get("/api/fs/read-encoding", (req, res) => {
  try {
    const filePath = safePath(req.query.path as string);
    const encoding = (req.query.encoding as string) || "utf-8";
    const raw = readFileResilient(filePath);
    const content = decodeWithEncoding(raw, encoding);
    res.json({ path: filePath, content, encoding });
  } catch (err) {
    res.status(statusForFsError(err)).json({ error: String(err), code: (err as any)?.code || "UNKNOWN" });
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

app.post("/api/fs/write", async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined || content === null) {
      return res.status(400).json({ error: "Missing path or content" });
    }
    const resolved = safePath(filePath);
    // Ensure parent directory exists (covers new files in not-yet-created subfolders)
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    await writeFileResilient(resolved, String(content));
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

// Read a file as binary (needed for browser file upload)
app.get("/api/fs/read-binary", async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "Missing path" });
    const resolved = safePath(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });
    res.sendFile(resolved);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/fs/create-file", (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: "Missing path" });
    const resolved = safePath(filePath);
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (!fs.existsSync(resolved)) {
      fs.writeFileSync(resolved, content || "", "utf-8");
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete a file or directory (recursive).
app.delete("/api/fs/delete", async (req, res) => {
  try {
    const { path: targetPath } = req.body || {};
    if (!targetPath) return res.status(400).json({ error: "Missing path" });
    const resolved = safePath(targetPath);
    if (!fs.existsSync(resolved)) return res.json({ success: true });
    // Retry on transient Windows lock errors (EBUSY/EPERM/EACCES).
    const delays = [0, 60, 150, 300, 600];
    let lastErr: any;
    for (const wait of delays) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        if (fs.statSync(resolved).isDirectory()) {
          fs.rmSync(resolved, { recursive: true, force: true });
        } else {
          fs.unlinkSync(resolved);
        }
        return res.json({ success: true });
      } catch (err: any) {
        lastErr = err;
        const code = err?.code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
        if ((code === "EPERM" || code === "EACCES") && fs.existsSync(resolved)) {
          try { fs.chmodSync(resolved, 0o666); } catch { /* */ }
        }
      }
    }
    throw lastErr;
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Rename / move a file or directory.
app.post("/api/fs/rename", (req, res) => {
  try {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: "Missing oldPath or newPath" });
    const from = safePath(oldPath);
    const to = safePath(newPath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── System stats ──
let prevCpuTimesStatus = os.cpus().map((c) => c.times);
let prevCpuTimesStats = os.cpus().map((c) => c.times);
let prevCpuTimeStats = Date.now();
let prevProcCpu = process.cpuUsage();
let prevProcTime = Date.now();
let prevNetBytes: { rx: number; tx: number } | null = null;
let prevNetTime = 0;
let cachedProcesses: ProcessSample[] | null = null;
let processCacheAge = 0;

// ── Minimal CPU poll for status bar (avoids heavy execSync disk queries) ──
let lastCpuPercent = 0;
app.get("/api/system/cpu", (_req, res) => {
  try {
    const cpus = os.cpus();
    let totalDelta = 0, totalIdle = 0;
    for (let i = 0; i < cpus.length; i++) {
      const prev = prevCpuTimesStatus[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
      const cur = cpus[i].times;
      const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
      const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
      const delta = curTotal - prevTotal;
      const idle = cur.idle - prev.idle;
      totalDelta += delta;
      totalIdle += idle;
    }
    prevCpuTimesStatus = cpus.map((c) => c.times);
    lastCpuPercent = totalDelta > 0 ? Math.round((1 - totalIdle / totalDelta) * 100) : 0;
  } catch {}
  res.json({ cpuPercent: lastCpuPercent });
});

let firstStatsCall = true;

app.get("/api/system/stats", (_req, res) => {
  try {
    const now = Date.now();
    const cpus = os.cpus();
    const cpuCount = cpus.length;

    // CPU usage per core + total
    const cpuUsage: number[] = [];
    let totalDelta = 0;
    let totalIdle = 0;

    for (let i = 0; i < cpus.length; i++) {
      const prev = prevCpuTimesStats[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
      const cur = cpus[i].times;
      const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
      const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
      const delta = curTotal - prevTotal;
      const idle = cur.idle - prev.idle;
      totalDelta += delta;
      totalIdle += idle;
      cpuUsage.push(Math.round((1 - idle / (delta || 1)) * 100));
    }

    prevCpuTimesStats = cpus.map((c) => c.times);
    prevCpuTimeStats = now;

    const cpuPercent = totalDelta > 0 ? Math.round((1 - totalIdle / totalDelta) * 100) : 0;

    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Uptime
    const uptime = os.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const uptimeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;

    // Load average
    const loadAvg = os.loadavg();

    // ── IDE process stats ──
    const procCpuPct = firstStatsCall ? 0 : (() => {
      const nowProc = process.cpuUsage(prevProcCpu);
      const wallElapsed = (now - prevProcTime) / 1000;
      const procCpuMs = (nowProc.user + nowProc.system) / 1000;
      const pct = wallElapsed > 0 ? Math.round((procCpuMs / (wallElapsed * cpuCount)) * 100) : 0;
      return Math.min(pct, 100);
    })();
    prevProcCpu = process.cpuUsage();
    prevProcTime = now;
    firstStatsCall = false;

    const memInfo = process.memoryUsage();

    // Categorised processes
    const processesByCategory: Array<{
      category: string;
      processes: Array<{ name: string; pid: number; ram: number; ramPercent: number; cpu: number }>;
    }> = [];

    // Get process listing (sampled) — cached, only refresh every 5 polls
    if (processCacheAge <= 0 || !cachedProcesses) {
      cachedProcesses = sampleProcesses();
      processCacheAge = 5;
    }
    processCacheAge--;
    const sampled = cachedProcesses;
    const ourPid = process.pid;
    const isOurProcess = (name: string, pid: number) =>
      pid === ourPid ||
      name.toLowerCase().includes("node") ||
      name.toLowerCase().includes("tsx") ||
      name.toLowerCase().includes("electron") ||
      name.toLowerCase().includes("harness");

    // IDE services (the main Harness node process + electron)
    const ideServices = sampled.filter((p) => isOurProcess(p.name, p.pid) && !p.name.toLowerCase().includes("cmd") && !p.name.toLowerCase().includes("powershell") && !p.name.toLowerCase().includes("conhost"));
    // Terminal processes spawned by IDE
    const terminals = sampled.filter((p) => {
      const n = p.name.toLowerCase();
      return n.includes("cmd") || n.includes("powershell") || n.includes("conhost") || n.includes("bash") || n.includes("zsh") || n.includes("terminal");
    });
    // Other IDE-related processes
    const others = sampled.filter((p) => isOurProcess(p.name, p.pid) && !ideServices.some((s) => s.pid === p.pid) && !terminals.some((t) => t.pid === p.pid));
    // Non-IDE background (top 20 by RAM, skip idle)
    const nonIde = sampled
      .filter((p) => p.pid !== 0 && !isOurProcess(p.name, p.pid) && !terminals.some((t) => t.pid === p.pid))
      .sort((a, b) => b.ram - a.ram)
      .slice(0, 20);

    const buildProc = (p: ProcessSample) => ({
      name: p.name,
      pid: p.pid,
      ram: p.ram,
      ramPercent: p.ramPercent,
      cpu: p.pid === ourPid ? Math.min(procCpuPct, 100) : 0,
    });

    if (ideServices.length) processesByCategory.push({ category: "IDE Basic Service", processes: ideServices.map(buildProc) });
    if (terminals.length) processesByCategory.push({ category: "User Terminal", processes: terminals.map(buildProc) });
    if (others.length) processesByCategory.push({ category: "Others", processes: others.map(buildProc) });
    if (nonIde.length) processesByCategory.push({ category: "Non-IDE", processes: nonIde.map(buildProc) });

    // ── Disk breakdown ──
    const cwd = path.resolve(process.cwd());

    // OS-level disk info for the cwd drive
    let diskTotal = 0, diskFree = 0, diskModel = "", diskDrive = "";
    try {
      diskDrive = (path.parse(cwd).root || "C:").replace(/\\/g, "");
      if (process.platform === "win32") {
        // Get Size and FreeSpace
        const rawSize = execSync(`wmic logicaldisk where "DeviceID='${diskDrive}'" get Size,FreeSpace /format:csv`, { encoding: "utf8", timeout: 3000 });
        const mSize = rawSize.match(/(\d+)\s*,\s*(\d+)/);
        if (mSize) { diskFree = parseInt(mSize[1], 10); diskTotal = parseInt(mSize[2], 10); }
        // Get disk model via diskdrive
        try {
          const rawModel = execSync('wmic diskdrive where "MediaType!=\'External hard disk media\'" get Model /format:csv', { encoding: "utf8", timeout: 2000 });
          const lines = rawModel.trim().split(/\r?\n/).filter((l) => l.trim() && !l.includes("Node,Model"));
          if (lines.length > 0) {
            diskModel = lines[0].replace(/.*?,/, "").replace(/"/g, "").trim();
          }
        } catch { /* model optional */ }
      } else {
        // Unix: df for the cwd mount
        const raw = execSync("df -h /", { encoding: "utf8", timeout: 2000 });
        const m = raw.match(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+%)/);
        if (m) { diskTotal = parseInt(m[1], 10) * 1024; diskFree = parseInt(m[3], 10) * 1024; }
      }
    } catch { /* ignore */ }

    const diskBreakdown: Array<{ component: string; size: number }> = [];
    const dirs = ["server", "client", "electron"];
    for (const d of dirs) {
      const p = path.join(cwd, d);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        diskBreakdown.push({ component: d, size: dirSizeQuick(p) });
      }
    }
    // Also measure node_modules for reference
    const nm = path.join(cwd, "node_modules");
    if (fs.existsSync(nm) && fs.statSync(nm).isDirectory()) {
      diskBreakdown.push({ component: "node_modules", size: dirSizeQuick(nm) });
    }

    // ── Network stats ──
    let totalRx = 0, totalTx = 0;
    const netElapsed = prevNetTime ? (now - prevNetTime) / 1000 : 0;
    try {
      if (process.platform === "win32") {
        const raw = execSync("netstat -e", { encoding: "utf8", timeout: 2000 });
        const mRx = raw.match(/Bytes\s+(\d+)/);
        const mTx = raw.match(/Bytes\s+\d+\s+(\d+)/);
        if (mRx && mTx) { totalRx = parseInt(mRx[1], 10); totalTx = parseInt(mTx[1], 10); }
      } else {
        const raw = execSync("cat /proc/net/dev", { encoding: "utf8", timeout: 2000 });
        for (const line of raw.split(/\r?\n/).slice(2)) {
          const m = line.match(/^\s*([^:]+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
          if (m && m[1].trim() !== "lo") { totalRx += parseInt(m[2], 10); totalTx += parseInt(m[3], 10); }
        }
      }
    } catch { /* optional */ }

    const netRxRate = netElapsed > 0 && prevNetBytes ? Math.round((totalRx - prevNetBytes.rx) / netElapsed) : 0;
    const netTxRate = netElapsed > 0 && prevNetBytes ? Math.round((totalTx - prevNetBytes.tx) / netElapsed) : 0;
    prevNetBytes = { rx: totalRx, tx: totalTx };
    prevNetTime = now;

    // IP addresses
    const ipAddresses: Array<{ name: string; address: string; mac: string }> = [];
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          ipAddresses.push({ name, address: addr.address, mac: addr.mac || "" });
        }
      }
    }

    const network = { totalRx, totalTx, rxRate: netRxRate, txRate: netTxRate, ipAddresses };

    res.json({
      cpu: {
        percent: cpuPercent,
        cores: cpuCount,
        perCore: cpuUsage,
        model: cpus[0]?.model || "Unknown",
        speed: cpus[0]?.speed || 0,
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percent: Math.round((usedMem / totalMem) * 100),
      },
      uptime: uptimeStr,
      loadAvg,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      processesByCategory,
      disk: {
        total: diskTotal,
        free: diskFree,
        used: diskTotal - diskFree,
        percent: diskTotal > 0 ? Math.round(((diskTotal - diskFree) / diskTotal) * 100) : 0,
        model: diskModel,
        drive: diskDrive,
      },
      diskBreakdown,
      network,
      ourProcess: {
        pid: process.pid,
        cpu: Math.min(procCpuPct, 100),
        ram: memInfo.rss,
        ramPercent: Math.round((memInfo.rss / totalMem) * 100),
        heapTotal: memInfo.heapTotal,
        heapUsed: memInfo.heapUsed,
        uptime: Math.round(process.uptime()),
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

interface ProcessSample {
  name: string;
  pid: number;
  ram: number;
  ramPercent: number;
}

function sampleProcesses(): ProcessSample[] {
  const totalMem = os.totalmem();
  try {
    if (process.platform === "win32") {
      // tasklist /FO CSV: "ImageName","PID","SessionName","Session#","Mem Usage"
      const raw = execSync("tasklist /FO CSV /NH", { encoding: "utf8", timeout: 3000 }).trim();
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      const result: ProcessSample[] = [];
      for (const line of lines) {
        const parts = line.split('","');
        if (parts.length < 5) continue;
        const name = (parts[0] ?? "").replace(/^"/, "").replace(/\.exe$/i, "");
        const pid = parseInt((parts[1] ?? "").replace(/"/g, ""), 10);
        const memStr = (parts[4] ?? "").replace(/"/g, "").replace(/[,\s]K$/i, "").replace(/,/g, "");
        const memKb = parseInt(memStr, 10);
        if (isNaN(pid) || isNaN(memKb)) continue;
        result.push({ name, pid, ram: memKb * 1024, ramPercent: Math.round((memKb * 1024 / totalMem) * 100) });
      }
      return result;
    } else {
      // Unix: ps -eo comm,pid,rss --no-headers
      const raw = execSync("ps -eo comm,pid,rss --no-headers", { encoding: "utf8", timeout: 3000 }).trim();
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      const result: ProcessSample[] = [];
      for (const line of lines) {
        const m = line.match(/^(.+?)\s+(\d+)\s+(\d+)/);
        if (!m) continue;
        const name = (m[1] || "").replace(/.*[/\\]/, "");
        const pid = parseInt(m[2], 10);
        const ramKb = parseInt(m[3], 10);
        if (isNaN(pid) || isNaN(ramKb)) continue;
        result.push({ name, pid, ram: ramKb * 1024, ramPercent: Math.round((ramKb * 1024 / totalMem) * 100) });
      }
      return result;
    }
  } catch {
    return [];
  }
}

function dirSizeQuick(dirPath: string): number {
  let total = 0;
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fp = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        if (item.name === "node_modules" || item.name === ".git" || item.name === "dist") continue;
        total += dirSizeQuick(fp);
      } else {
        try { total += fs.statSync(fp).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}

// ── Encoding detection ──
function detectAndDecode(raw: Buffer): { content: string; encoding: string } {
  if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) {
    return { content: decodeWithEncoding(raw, "utf16le"), encoding: "utf16le" };
  }
  if (raw.length >= 2 && raw[0] === 0xFE && raw[1] === 0xFF) {
    return { content: decodeWithEncoding(raw, "utf16be"), encoding: "utf16be" };
  }
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    return { content: raw.subarray(3).toString("utf-8"), encoding: "utf8bom" };
  }
  return { content: raw.toString("utf-8"), encoding: "utf8" };
}

function decodeWithEncoding(raw: Buffer, encoding: string): string {
  // strip any BOM before decoding
  let buf = raw;
  if (encoding === "utf8" || encoding === "utf-8") {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
    return buf.toString("utf-8");
  }
  if (encoding === "utf16le" || encoding === "UTF-16 LE") {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) buf = buf.subarray(2);
    return buf.toString("utf16le");
  }
  if (encoding === "utf16be" || encoding === "UTF-16 BE") {
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) buf = buf.subarray(2);
    return buf.swap16().toString("utf16le"); // Node has no utf16be decoder, swap bytes then decode as LE
  }
  if (encoding === "utf8bom") {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
    return buf.toString("utf-8");
  }
  if (encoding === "latin1" || encoding === "ISO 8859-1") {
    return buf.toString("latin1");
  }
  return buf.toString("utf-8");
}

// ── Git / SCM endpoints ──
function gitCwd(reqPath?: string): string {
  if (reqPath) {
    let dir = path.resolve(reqPath);
    while (true) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    // No .git found anywhere — use the resolved path so git fails with "not a repo"
    return path.resolve(reqPath);
  }
  // No path given — only then fall back to server's cwd
  return process.cwd();
}

app.get("/api/git/status", (req, res) => {
  try {
    const cwd = gitCwd(req.query.path as string | undefined);
    const statusRaw = execSync("git status --porcelain -u", { cwd, encoding: "utf8", timeout: 5000 });
    const lines = statusRaw.trim().split(/\r?\n/).filter(Boolean);
    const staged: Array<{ path: string; status: string }> = [];
    const unstaged: Array<{ path: string; status: string }> = [];
    for (const line of lines) {
      const idx = line.substring(0, 2);
      const file = line.substring(3).trim();
      const stageStatus = idx[0];
      const workStatus = idx[1];
      if (stageStatus !== " ") staged.push({ path: file, status: `${stageStatus}${workStatus !== " " ? workStatus : ""}` });
      if (workStatus !== " ") unstaged.push({ path: file, status: workStatus });
      if (stageStatus === " " && workStatus === " ") unstaged.push({ path: file, status: "U" }); // untracked
    }
    // Get current branch
    let branch = "";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", timeout: 3000 }).trim();
    } catch { branch = "unknown"; }
    // Get git root for client to resolve relative paths
    let gitRoot = "";
    try {
      gitRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", timeout: 3000 }).trim();
    } catch { /* */ }
    res.json({ ok: true, branch, gitRoot: gitRoot || cwd, staged, unstaged });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || "Not a git repository" });
  }
});

app.get("/api/git/log", (req, res) => {
  try {
    const cwd = gitCwd(req.query.path as string | undefined);
    const limit = parseInt((req.query.limit as string) || "20", 10);
    const remote = (req.query.remote as string) || "origin";
    const raw = execSync(
      `git log --max-count=${limit} --format="%H||%an||%ae||%ad||%s||%D" --date=relative`,
      { cwd, encoding: "utf8", timeout: 5000 }
    );
    const commits = raw.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, author, email, date, message, refs] = line.split("||");
      return { hash, author, email, date, message, refs };
    });
    // Try getting GitHub remote URL
    let remoteUrl = "";
    try {
      remoteUrl = execSync(`git remote get-url ${remote}`, { cwd, encoding: "utf8", timeout: 3000 }).trim();
    } catch { /* */ }
    res.json({ ok: true, commits, remoteUrl });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || "Not a git repository" });
  }
});

app.post("/api/git/fetch", (req, res) => {
  try {
    const cwd = gitCwd(req.query.path as string | undefined);
    execSync("git fetch --all", { cwd, encoding: "utf8", timeout: 30000 });
    res.json({ ok: true });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || "Fetch failed" });
  }
});

app.post("/api/git/pull", (req, res) => {
  try {
    const cwd = gitCwd(req.query.path as string | undefined);
    execSync("git pull", { cwd, encoding: "utf8", timeout: 30000 });
    res.json({ ok: true });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || "Pull failed" });
  }
});

app.post("/api/git/push", (req, res) => {
  try {
    const cwd = gitCwd(req.query.path as string | undefined);
    execSync("git push", { cwd, encoding: "utf8", timeout: 30000 });
    res.json({ ok: true });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || "Push failed" });
  }
});

app.get("/api/git/diff", (req, res) => {
  try {
    const cwd = gitCwd(req.query.path as string | undefined);
    const file = req.query.file as string;
    if (!file) return res.status(400).json({ ok: false, error: "file param required" });
    // Make path relative to git root for git diff
    const relFile = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    const raw = execSync(`git diff -- "${relFile}"`, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    res.json({ ok: true, file, diff: raw });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || "Diff failed" });
  }
});

// ── LSP (Language Server) endpoints ──
import { getCompletions, getFileDiagnostics, getLspStatus, watchDiagnostics, notifyFileChange } from "./lsp";

app.post("/api/lsp/complete", (req, res) => {
  try {
    const { rootPath, language, filePath, line, column } = req.body || {};
    if (!rootPath || !language || !filePath) {
      return res.json({ ok: false, items: [] });
    }
    getCompletions(rootPath, language, filePath, line || 1, column || 1)
      .then((items) => res.json({ ok: true, items }))
      .catch(() => res.json({ ok: false, items: [] }));
  } catch {
    res.json({ ok: false, items: [] });
  }
});

// Push-based real-time diagnostics via SSE (VS Code style).
// The client opens one persistent connection per language and receives
// publishDiagnostics events as the LSP server emits them.
app.get("/api/lsp/watch", (req, res) => {
  const rootPath = String(req.query.rootPath || "");
  const language = String(req.query.language || "");
  if (!rootPath || !language) {
    return res.status(400).json({ ok: false, error: "Missing rootPath or language" });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // SSE comment to flush headers

  const result = watchDiagnostics(rootPath, language, res);
  if (!result.ok) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: result.error })}\n\n`);
    res.end();
    return;
  }
  // Connection stays open — watchDiagnostics registered the response
  // in session.sseClients, so publishDiagnostics broadcasts to it.
  req.on("close", () => { /* cleanup handled in watchDiagnostics */ });
});

// Legacy polling endpoint (kept for backward compatibility).
// Prefer GET /api/lsp/watch + POST didChange via notifyFileChange.
app.post("/api/lsp/diagnostics", (req, res) => {
  try {
    const { rootPath, language, filePath, text } = req.body || {};
    if (!rootPath || !language || !filePath) {
      return res.json({ ok: false, markers: [], error: "Missing required parameters (rootPath, language, filePath)" });
    }
    getFileDiagnostics(rootPath, language, filePath, text || "")
      .then(({ markers, error }) => {
        res.json({ ok: true, markers, error });
      })
      .catch((err) => {
        console.error(`LSP diagnostics error: ${err instanceof Error ? err.message : String(err)}`);
        res.json({ ok: false, markers: [], error: err instanceof Error ? err.message : String(err) });
      });
  } catch (err) {
    console.error(`LSP diagnostics fatal: ${err instanceof Error ? err.message : String(err)}`);
    res.json({ ok: false, markers: [], error: err instanceof Error ? err.message : String(err) });
  }
});

// ── LSP status – current error state for all languages ──
app.get("/api/lsp/status", (_req, res) => {
  try {
    const status = getLspStatus();
    res.json({ ok: true, sessions: status });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Health check ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Resource Monitor page (loaded by Electron resource window) ──
app.get("/resources", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>System Resources</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #1e1e1e; color: #d4d4d4; font-size: 12px; overflow: hidden; }
  .wrap { display: flex; flex-direction: column; height: 100vh; }
  .header { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: #1a1a1a; border-bottom: 1px solid #333; flex-shrink: 0; }
  .host { color: #4ec94e; font-weight: 600; }
  .os { color: #888; }
  .uptime { color: #888; margin-left: auto; font-family: monospace; }
  .tabs { display: flex; flex-shrink: 0; border-bottom: 1px solid #333; background: #1a1a1a; }
  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: #888; padding: 7px 16px; font-size: 11px; font-family: inherit; cursor: pointer; transition: color .15s, border-color .15s; }
  .tab.active { color: #d4d4d4; border-bottom-color: #4ec94e; }
  .body { flex: 1; overflow-y: auto; padding: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-content: start; }
  .body .card { margin-bottom: 0; }
  .card { background: #252526; border: 1px solid #333; border-radius: 6px; margin-bottom: 8px; }
  .sec-header { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; user-select: none; border-bottom: 1px solid #333; }
  .sec-header:hover { background: #2a2a2a; }
  .sec-toggle { font-size: 9px; width: 12px; color: #888; }
  .sec-title { font-size: 11px; font-weight: 600; }
  .sec-count { font-size: 10px; color: #888; margin-left: auto; }
  .sec-body { padding: 6px 10px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 11px; }
  .label { color: #888; min-width: 55px; }
  .val { font-weight: 600; font-family: monospace; text-align: right; min-width: 70px; }
  .val-lg { font-size: 14px; font-weight: 600; font-family: monospace; min-width: 70px; text-align: right; }
  .bar-wrap { flex: 1; height: 8px; background: #3c3c3c; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width .6s; }
  .core-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; font-size: 10px; }
  .core-label { width: 28px; color: #888; font-family: monospace; }
  .core-bar { flex: 1; height: 6px; background: #3c3c3c; border-radius: 3px; overflow: hidden; }
  .core-fill { height: 100%; background: #4ec94e; border-radius: 3px; transition: width .6s; }
  .core-val { width: 36px; text-align: right; font-family: monospace; color: #bbb; }
  .load-grid { display: flex; gap: 16px; padding: 4px 0; }
  .load-item { text-align: center; }
  .load-label { font-size: 10px; color: #888; display: block; }
  .load-value { font-size: 13px; font-weight: 600; font-family: monospace; }
  .net-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
  .net-dir { display: flex; align-items: center; gap: 6px; }
  .net-icon { font-size: 14px; width: 16px; }
  .net-value { font-weight: 600; font-family: monospace; }
  .proc-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 10px; }
  .proc-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proc-pid { color: #888; font-family: monospace; }
  .proc-metric { display: flex; align-items: center; gap: 4px; min-width: 120px; }
  .proc-metric .bar-wrap { height: 5px; width: 70px; }
  .proc-heap { margin-top: 1px; font-size: 9px; color: #888; font-family: monospace; }
  .empty { color: #666; padding: 8px; font-style: italic; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header" id="header">
    <span class="host" id="hostname">---</span>
    <span class="os" id="platform">---</span>
    <span class="uptime" id="uptime">Up ---</span>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="body" id="body"></div>
</div>
<script>
var DEBUG = true;
window.onerror = function(msg, url, line, col, err) {
  var body = document.getElementById("body");
  if (body) body.innerHTML = '<div class="empty" style="color:#e74c3c">JS Error: ' + msg + ' (line ' + line + ')</div>';
  return false;
};

const API = "/api/system/stats";
const TABS = ["Overview", "CPU & Memory", "Disk", "Network"];
var tab = "Overview";
var collapsed = {};
var lastData = null;

function fmt(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1024).toFixed(0) + " KB";
}

function bar(w, c, h, id) {
  return '<div class="bar-wrap" style="height:' + h + 'px"><div id="' + (id||'') + '" class="bar-fill" style="width:' + w + '%;background:' + c + '"></div></div>';
}

function secHeader(key, label, count, coll) {
  return '<div class="sec-header" onclick="toggle(\\'' + key + '\\')">' +
    '<span class="sec-toggle">' + (coll ? '\u25b8' : '\u25be') + '</span>' +
    '<span class="sec-title">' + label + '</span>' +
    (count ? '<span class="sec-count">' + count + '</span>' : '') + '</div>';
}

function renderTabs() {
  document.getElementById("tabs").innerHTML = TABS.map(function(t) {
    return '<button class="tab' + (t === tab ? ' active' : '') + '" onclick="setTab(\\'' + t + '\\')">' + t + '</button>';
  }).join("");
}

function setTab(t) { tab = t; renderTabs(); render(); }
function toggle(k) { collapsed[k] = !collapsed[k]; render(); }

function renderProcs(cats, our) {
  if (!cats.length) return "";
  var h = "";
  for (var i = 0; i < cats.length; i++) {
    var cat = cats[i];
    var items = "";
    for (var j = 0; j < cat.processes.length; j++) {
      var p = cat.processes[j];
      var heap = p.pid === (our && our.pid)
        ? '<div class="proc-heap">Heap ' + fmt(our.heapUsed) + ' / ' + fmt(our.heapTotal) + ' \u00b7 Up ' + fmtUp(our.uptime) + '</div>' : "";
      items += '<div class="proc-row">' +
        '<span class="proc-name" title="' + p.name + '">' + p.name + '</span>' +
        '<span class="proc-pid">PID ' + p.pid + '</span>' +
        '<div class="proc-metric">' + bar(p.cpu, "#4D6BFE", 5, "") + '<span>' + p.cpu + '%</span></div>' +
        '<div class="proc-metric">' + bar(p.ramPercent, "#e2b714", 5, "") + '<span>' + fmt(p.ram) + '</span></div>' +
        '</div>' + heap;
    }
    h += '<div class="card">' + secHeader("proc-" + cat.category, cat.category, String(cat.processes.length), !!collapsed["proc-" + cat.category]) +
      '<div class="sec-body"' + (collapsed["proc-" + cat.category] ? ' style="display:none"' : '') + '>' + items + '</div></div>';
  }
  return h;
}

function fmtUp(s) { return s < 60 ? s + 's' : s < 3600 ? Math.floor(s/60) + 'm' : Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm'; }

function render() {
  if (!lastData) return;
  var s = lastData;
  var allCount = s.processesByCategory.reduce(function(a,c){ return a + c.processes.length; }, 0);
  var cores = "";
  for (var i = 0; i < s.perCore.length; i++) {
    cores += '<div class="core-row"><span class="core-label">C' + i + '</span><div class="core-bar"><div class="core-fill" style="width:' + s.perCore[i] + '%"></div></div><span class="core-val">' + s.perCore[i] + '%</span></div>';
  }
  var ipSection = s.network.ipAddresses.length
    ? '<div style="margin-top:4px;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.3px">IP Addresses</div>' +
      s.network.ipAddresses.map(function(ip){ return '<div class="row"><span class="label">' + ip.name + '</span><span class="val">' + ip.address + '</span></div>'; }).join("")
    : "";
  var diskItems = s.diskBreakdown.map(function(d){ return '<div class="row"><span class="label">' + d.component + '/</span><span class="val">' + fmt(d.size) + '</span></div>'; }).join("");

  var overview = '<div class="card">' + secHeader("ov-cpu", "CPU", s.cpuPercent + '%', !!collapsed["ov-cpu"]) +
    '<div class="sec-body"' + (collapsed["ov-cpu"] ? ' style="display:none"' : '') + '>' +
    '<div class="row"><span class="label">Usage</span>' + bar(s.cpuPercent, "#4ec94e", 8, "ovCpuBar") + '<span class="val">' + s.cpuPercent + '%</span></div>' +
    '<div class="row"><span class="label">Speed</span><span class="val">' + s.cpuSpeed + ' MHz</span></div>' +
    '<div class="row"><span class="label">Model</span><span class="val" style="font-size:10px;font-weight:normal">' + s.cpuModel + '</span></div>' +
    '</div></div>' +
    '<div class="card">' + secHeader("ov-mem", "Memory", s.memPercent + '%', !!collapsed["ov-mem"]) +
    '<div class="sec-body"' + (collapsed["ov-mem"] ? ' style="display:none"' : '') + '>' +
    '<div class="row"><span class="label">Usage</span>' + bar(s.memPercent, "#e2b714", 8, "ovMemBar") + '<span class="val">' + s.memPercent + '%</span></div>' +
    '<div class="row"><span class="label">Used</span><span class="val">' + fmt(s.memUsed) + '</span></div>' +
    '<div class="row"><span class="label">Total</span><span class="val">' + fmt(s.memTotal) + '</span></div>' +
    '</div></div>' +
    (s.disk.total > 0 ? '<div class="card">' + secHeader("ov-disk", "Disk (" + (s.disk.drive||"C:") + ")", s.disk.percent + '%', !!collapsed["ov-disk"]) +
    '<div class="sec-body"' + (collapsed["ov-disk"] ? ' style="display:none"' : '') + '>' +
    '<div class="row"><span class="label">Usage</span>' + bar(s.disk.percent, "#4D6BFE", 8, "ovDiskBar") + '<span class="val">' + s.disk.percent + '%</span></div>' +
    '<div class="row"><span class="label">Free</span><span class="val">' + fmt(s.disk.free) + '</span></div>' +
    '<div class="row"><span class="label">Total</span><span class="val">' + fmt(s.disk.total) + '</span></div>' +
    (s.disk.model ? '<div class="row"><span class="label">Model</span><span class="val" style="font-size:10px;font-weight:normal">' + s.disk.model + '</span></div>' : '') +
    '</div></div>' : '') +
    '<div class="card">' + secHeader("ov-net", "Network", "", !!collapsed["ov-net"]) +
    '<div class="sec-body"' + (collapsed["ov-net"] ? ' style="display:none"' : '') + '>' +
    '<div class="row"><span class="label">\u2193 Down</span><span class="val">' + fmt(s.network.rxRate) + '/s</span></div>' +
    '<div class="row"><span class="label">\u2191 Up</span><span class="val">' + fmt(s.network.txRate) + '/s</span></div>' +
    ipSection +
    '</div></div>';

  var cpuMem = '<div class="card">' + secHeader("cpu-total", "CPU Usage", s.cpuPercent + '%', !!collapsed["cpu-total"]) +
    '<div class="sec-body"' + (collapsed["cpu-total"] ? ' style="display:none"' : '') + '>' +
    '<div class="row">' + bar(s.cpuPercent, "#4ec94e", 10, "cpuTotalBar") + '<span class="val-lg">' + s.cpuPercent + '%</span></div>' +
    '</div></div>' +
    '<div class="card">' + secHeader("cpu-cores", "Per-Core (" + s.cpuCores + " cores)", "", !!collapsed["cpu-cores"]) +
    '<div class="sec-body"' + (collapsed["cpu-cores"] ? ' style="display:none"' : '') + '>' + cores + '</div></div>' +
    '<div class="card">' + secHeader("cpu-info", "Processor Info", "", !!collapsed["cpu-info"]) +
    '<div class="sec-body"' + (collapsed["cpu-info"] ? ' style="display:none"' : '') + '>' +
    '<div class="row"><span class="label">Model</span><span class="val" style="font-size:10px;font-weight:normal">' + s.cpuModel + '</span></div>' +
    '<div class="row"><span class="label">Speed</span><span class="val">' + s.cpuSpeed + ' MHz</span></div>' +
    '<div class="row"><span class="label">Cores</span><span class="val">' + s.cpuCores + '</span></div>' +
    '</div></div>' +
    '<div class="card">' + secHeader("mem-detail", "Memory", s.memPercent + '%', !!collapsed["mem-detail"]) +
    '<div class="sec-body"' + (collapsed["mem-detail"] ? ' style="display:none"' : '') + '>' +
    '<div class="row">' + bar(s.memPercent, "#e2b714", 10, "memTotalBar") + '<span class="val-lg">' + s.memPercent + '%</span></div>' +
    '<div class="row"><span class="label">Used</span><span class="val">' + fmt(s.memUsed) + '</span></div>' +
    '<div class="row"><span class="label">Free</span><span class="val">' + fmt(s.memTotal - s.memUsed) + '</span></div>' +
    '<div class="row"><span class="label">Total</span><span class="val">' + fmt(s.memTotal) + '</span></div>' +
    '</div></div>' +
    '<div class="card">' + secHeader("load-detail", "Load Average", "", !!collapsed["load-detail"]) +
    '<div class="sec-body"' + (collapsed["load-detail"] ? ' style="display:none"' : '') + '>' +
    '<div class="load-grid">' + ["1m","5m","15m"].map(function(l, i){ return '<div class="load-item"><span class="load-label">' + l + '</span><span class="load-value">' + ((s.loadAvg[i]||0).toFixed(2)) + '</span></div>'; }).join("") + '</div>' +
    '</div></div>' +
    '<div class="card">' + secHeader("proc-cpu", "Processes", String(allCount), !!collapsed["proc-cpu"]) +
    '<div class="sec-body"' + (collapsed["proc-cpu"] ? ' style="display:none"' : '') + '>' + renderProcs(s.processesByCategory, s.ourProcess) + '</div></div>';

  var disk = (s.disk.total > 0 ? '<div class="card">' + secHeader("disk-os", "Drive " + (s.disk.drive||"C:"), s.disk.percent + '%', !!collapsed["disk-os"]) +
    '<div class="sec-body"' + (collapsed["disk-os"] ? ' style="display:none"' : '') + '>' +
    '<div class="row">' + bar(s.disk.percent, "#569cd6", 10, "diskTotalBar") + '<span class="val-lg">' + s.disk.percent + '%</span></div>' +
    '<div class="row"><span class="label">Used</span><span class="val">' + fmt(s.disk.used) + '</span></div>' +
    '<div class="row"><span class="label">Free</span><span class="val">' + fmt(s.disk.free) + '</span></div>' +
    '<div class="row"><span class="label">Total</span><span class="val">' + fmt(s.disk.total) + '</span></div>' +
    (s.disk.model ? '<div class="row"><span class="label">Model</span><span class="val" style="font-size:10px;font-weight:normal">' + s.disk.model + '</span></div>' : '') +
    '</div></div>' : '') +
    '<div class="card">' + secHeader("disk-harness", "Harness Components", "", !!collapsed["disk-harness"]) +
    '<div class="sec-body"' + (collapsed["disk-harness"] ? ' style="display:none"' : '') + '>' +
    (diskItems || '<div class="empty">No data</div>') + '</div></div>';

  var net = '<div class="card">' + secHeader("net-speed", "Transfer Rates", "", !!collapsed["net-speed"]) +
    '<div class="sec-body"' + (collapsed["net-speed"] ? ' style="display:none"' : '') + '>' +
    '<div class="net-row"><div class="net-dir"><span class="net-icon">\u2193</span><span>Download</span></div><span class="net-value">' + fmt(s.network.rxRate) + '/s</span></div>' +
    '<div class="net-row"><div class="net-dir"><span class="net-icon">\u2191</span><span>Upload</span></div><span class="net-value">' + fmt(s.network.txRate) + '/s</span></div>' +
    '</div></div>' +
    '<div class="card">' + secHeader("net-total", "Total Transferred", "", !!collapsed["net-total"]) +
    '<div class="sec-body"' + (collapsed["net-total"] ? ' style="display:none"' : '') + '>' +
    '<div class="row"><span class="label">Received</span><span class="val">' + fmt(s.network.totalRx) + '</span></div>' +
    '<div class="row"><span class="label">Sent</span><span class="val">' + fmt(s.network.totalTx) + '</span></div>' +
    '</div></div>' +
    (s.network.ipAddresses.length ? '<div class="card">' + secHeader("net-ip", "IP Addresses", "", !!collapsed["net-ip"]) +
    '<div class="sec-body"' + (collapsed["net-ip"] ? ' style="display:none"' : '') + '>' +
    s.network.ipAddresses.map(function(ip){ return '<div class="row"><span class="label">' + ip.name + '</span><div style="flex:1;display:flex;align-items:center;gap:16px"><span class="val">' + ip.address + '</span>' + (ip.mac ? '<span style="font-size:10px;color:#666;font-family:monospace">' + ip.mac + '</span>' : '') + '</div></div>'; }).join("") +
    '</div></div>' : '');

  var bodies = { "Overview": overview, "CPU & Memory": cpuMem, "Disk": disk, "Network": net };
  document.getElementById("body").innerHTML = bodies[tab] || overview;

  var ovCpuBar = document.getElementById("ovCpuBar");
  if (ovCpuBar) ovCpuBar.style.width = s.cpuPercent + '%';
  var ovMemBar = document.getElementById("ovMemBar");
  if (ovMemBar) ovMemBar.style.width = s.memPercent + '%';
  var ovDiskBar = document.getElementById("ovDiskBar");
  if (ovDiskBar) ovDiskBar.style.width = s.disk.percent + '%';
  var cpuTotalBar = document.getElementById("cpuTotalBar");
  if (cpuTotalBar) cpuTotalBar.style.width = s.cpuPercent + '%';
  var memTotalBar = document.getElementById("memTotalBar");
  if (memTotalBar) memTotalBar.style.width = s.memPercent + '%';
  var diskTotalBar = document.getElementById("diskTotalBar");
  if (diskTotalBar) diskTotalBar.style.width = s.disk.percent + '%';
}

var pollErrors = 0;
var polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    var res = await fetch(API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var raw = await res.json();
    if (raw.error) throw new Error(raw.error);
    lastData = {
      cpuPercent: raw.cpu.percent, cpuCores: raw.cpu.cores, cpuModel: raw.cpu.model, cpuSpeed: raw.cpu.speed,
      memPercent: raw.memory.percent, memUsed: raw.memory.used, memTotal: raw.memory.total,
      uptime: raw.uptime, loadAvg: raw.loadAvg || [],
      hostname: raw.hostname, platform: raw.platform, arch: raw.arch,
      perCore: raw.cpu.perCore || [],
      processesByCategory: raw.processesByCategory || [],
      disk: raw.disk || { total: 0, free: 0, used: 0, percent: 0, model: "", drive: "" },
      diskBreakdown: raw.diskBreakdown || [],
      network: raw.network || { totalRx: 0, totalTx: 0, rxRate: 0, txRate: 0, ipAddresses: [] },
      ourProcess: raw.ourProcess || null,
    };
    pollErrors = 0;
    document.getElementById("hostname").textContent = lastData.hostname;
    document.getElementById("platform").textContent = lastData.platform + " " + lastData.arch;
    document.getElementById("uptime").textContent = "Up " + lastData.uptime;
    try {
      render();
    } catch(renderErr) {
      document.getElementById("body").innerHTML = '<div class="empty">Render error: ' + renderErr.message + '</div>';
    }
  } catch(e) {
    pollErrors++;
    document.getElementById("body").innerHTML = '<div class="empty">Failed to load resource data: ' + e.message + '. Retrying every 2s...</div>';
  }
  polling = false;
}

renderTabs();
document.getElementById("body").innerHTML = '<div class="empty">Connecting to server...</div>';
poll();
setInterval(poll, 3000);
</script>
</body>
</html>`);
});

// ── MCP (Model Context Protocol) endpoints ──
import { HarnessMcpServer, handleMcpSseRequest } from "./mcp";

const mcpServer = new HarnessMcpServer();

// JSON-RPC over HTTP (POST)
app.post("/api/mcp", async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.method) {
      return res.status(400).json({ error: "Invalid JSON-RPC request" });
    }
    // Update project root from request if provided
    if (body.params?.projectRoot) {
      mcpServer.setProjectRoot(String(body.params.projectRoot));
    }
    const response = await handleMcpSseRequest(mcpServer, body);
    if (response) {
      res.json(response);
    } else {
      res.status(202).json({ status: "accepted" }); // Notification, no response
    }
  } catch (err) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  }
});

// SSE transport (GET) — opens a persistent SSE connection for streaming MCP messages
app.get("/api/mcp/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial endpoint event
  const endpointUrl = "/api/mcp";
  res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

// ── Serve client (desktop / production) ──
const clientDist = path.resolve(__dirname, "..", "client", "dist");
if (process.env.HARNESS_SERVE_CLIENT === "1" && fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/|ws\/?|_browser\/?).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// ── Browser reverse proxy (universal — all URLs proxied for same-origin iframe access) ──

// Simple JSON syntax highlighter: wraps keys, strings, numbers, booleans, null in colored spans.
function highlightJson(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b)|(\bnull\b)|([\[\]{}])/g,
    (match, key, str, num, bool, nil, bracket) => {
      if (key) return `<span class="key">${key}</span>:`;
      if (str) return `<span class="str">${str}</span>`;
      if (num) return `<span class="num">${num}</span>`;
      if (bool) return `<span class="bool">${bool}</span>`;
      if (nil) return `<span class="nil">${nil}</span>`;
      if (bracket) return `<span class="bracket">${bracket}</span>`;
      return match;
    }
  );
}

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
      // Inject CSP to prevent proxied pages from accessing Harness APIs
      headers["content-security-policy"] =
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'self'; form-action *";

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
      } else if (contentType.includes("application/json") || contentType.includes("+json")) {
        // Pretty-print JSON responses with syntax highlighting in the browser
        delete headers["content-length"];
        headers["content-type"] = "text/html; charset=utf-8";
        let body = "";
        proxyRes.setEncoding("utf8");
        proxyRes.on("data", (chunk: string) => { body += chunk; });
        proxyRes.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const formatted = JSON.stringify(parsed, null, 2);
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1e1e1e;color:#d4d4d4;font:13px/1.5 'Cascadia Code','Fira Code',Consolas,monospace;padding:16px;white-space:pre-wrap;word-break:break-word}
.key{color:#8E9FFF}.str{color:#ce9178}.num{color:#b5cea8}.bool{color:#4D6BFE}.nil{color:#4D6BFE}.bracket{color:#ffd700}
</style></head><body>${highlightJson(formatted)}</body></html>`;
            res.writeHead(proxyRes.statusCode || 200, headers);
            res.end(html);
          } catch {
            res.writeHead(proxyRes.statusCode || 200, headers);
            res.end(body);
          }
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

// ── List DeepSeek models ──
app.get("/api/models", async (req, res) => {
  try {
    const { apiKey } = getEffectiveApiKey(req);
    if (!apiKey) return res.status(400).json({ error: "No API key configured" });
    const resp = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!resp.ok) return res.status(resp.status).json({ error: await resp.text() });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
      setLastWsGroupKey(nextGroupKey);
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

if (process.env.NODE_ENV !== "test") {
  const PORT_RANGES: [number, number][] = [[3001, 3100]];

  const tryPort = (rangeIdx = 0, offset = 0) => {
    if (rangeIdx >= PORT_RANGES.length) {
      throw new Error("No available ports in configured ranges");
    }
    const [start, end] = PORT_RANGES[rangeIdx];
    const port = start + offset;
    if (port > end) {
      tryPort(rangeIdx + 1, 0);
      return;
    }

    server.listen(port, () => {
      console.log(`Harness server running on http://localhost:${port}`);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.close();
        tryPort(rangeIdx, offset + 1);
      } else {
        throw err;
      }
    });
  };
  tryPort();
}

process.on("SIGINT", async () => {
  process.exit();
});
process.on("SIGTERM", async () => {
  process.exit();
});
