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
import { getFileTrackingService } from "./fileTracking";
import { API_KEYS_FILE, CLIENT_STATE_FILE } from "./hPaths";
import { encryptApiKeys, decryptApiKeys } from "./cryptoStore";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

export { app };

app.use(express.json({ limit: "10mb" }));

const CLIENT_API_KEY_COOKIE = "h_api_session";
const clientApiKeySessions = new Map<string, { apiKey: string; updatedAt: number }>();

// ── Persistent API key storage (~/.h/store/api-keys.enc) ──
// Encrypted with AES-256-GCM using a machine-specific key at ~/.h/.key.
// Migrates from the old plaintext ~/.h/api-keys.json on first startup.

const OLD_API_KEYS_FILE = path.join(os.homedir(), ".h", "api-keys.json");

function loadApiKeys(): void {
  try {
    // ── Migration: old plaintext → new encrypted ──
    if (!fs.existsSync(API_KEYS_FILE) && fs.existsSync(OLD_API_KEYS_FILE)) {
      const oldRaw = fs.readFileSync(OLD_API_KEYS_FILE, "utf-8");
      const entries: [string, { apiKey: string; updatedAt: number }][] = JSON.parse(oldRaw);
      const encrypted = encryptApiKeys(JSON.stringify(entries));
      const dir = path.dirname(API_KEYS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(API_KEYS_FILE, encrypted, "utf-8");
      // Don't delete the old file — keep as backup
    }

    if (!fs.existsSync(API_KEYS_FILE)) return;
    const encrypted = fs.readFileSync(API_KEYS_FILE, "utf-8");
    const raw = decryptApiKeys(encrypted);
    const entries: [string, { apiKey: string; updatedAt: number }][] = JSON.parse(raw);
    for (const [token, session] of entries) {
      clientApiKeySessions.set(token, session);
    }
  } catch { /* ignore corrupt/missing file */ }
}

function saveApiKeys(): void {
  try {
    const dir = path.dirname(API_KEYS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const encrypted = encryptApiKeys(JSON.stringify([...clientApiKeySessions.entries()]));
    fs.writeFileSync(API_KEYS_FILE, encrypted, "utf-8");
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
const shouldWriteServerStdout = process.env.H_DESKTOP !== "1";
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
  if (!message) return res.status(400).json({ error: "Missing message" });
  if (!model) return res.status(400).json({ error: "Missing model. Select a model in the client." });
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

    // After tool_start, yield to the event loop so the response buffer flushes
    // before the tool executes (which may use sync I/O and block the event loop).
    // Without this, tool_start and tool_end arrive in the same TCP packet and
    // the client renders the tool card only after the tool completes.
    const sendAndMaybeYeld = async (event: AgentSseEvent): Promise<boolean> => {
      sendEvent(event);
      if (event.type === "tool_start") {
        await new Promise<void>((r) => setImmediate(r));
      }
      return false;
    };

    const modelOpts = { model, apiKey };
    for await (const event of agentLoopStream(root, state, context || "", sessionId, modelOpts)) {
      await sendAndMaybeYeld(event);
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
  if (!message) return res.status(400).json({ error: "Missing message" });
  if (!model) return res.status(400).json({ error: "Missing model. Select a model in the client." });
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

    const sendAndMaybeYeld = async (event: AgentSseEvent): Promise<boolean> => {
      sendEvent(event);
      if (event.type === "tool_start") {
        await new Promise<void>((r) => setImmediate(r));
      }
      return false;
    };

    const modelOpts = { model, apiKey };
    for await (const event of agentLoopStepByStep(root, state, context || "", sessionId, modelOpts)) {
      await sendAndMaybeYeld(event);
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
  if (!sessionId || !toolCallId) {
    return res.status(400).json({ error: "Missing sessionId or toolCallId" });
  }
  const { apiKey } = getEffectiveApiKey(req);
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Add one in the client." });

  try {
    const state = getAgentSession(sessionId);
    if (!state) return res.status(404).json({ error: "Session not found" });

    // ── Step 1: Handle permission Allow/Deny or browser tool results ──
    let cmdResult: string | null = null;
    let permissionToolName: string | undefined = undefined;
    let permissionToolParams: Record<string, unknown> | undefined;
    let statePushed = false; // skip generic push when already pushed (e.g. summarized terminal output)

    // ── Sub-agent resume (streaming): check before normal flow ──
    if (state.pendingSubAgent && !(state.pendingPermission && state.pendingPermission.toolCallId === toolCallId)) {
      const psa = state.pendingSubAgent;
      state.pendingSubAgent = undefined;
      const subResult = await resumeSubAgent(
        psa.subState, psa.config, toolCallId, String(toolResult),
        { model, apiKey },
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
      const sendAndMaybeYeld = async (event: AgentSseEvent): Promise<boolean> => {
        sendEvent(event);
        if (event.type === "tool_start") {
          await new Promise<void>((r) => setImmediate(r));
        }
        return false;
      };
      sendEvent({ type: "tool_end", toolName: "delegate_task", toolResult: resultText, toolParams: {},
        subAgentName: psa.config.name,
        subAgentMessages: subResult.subState.messages.map((m: any) => ({
          role: m.role, content: m.content || "", name: m.name, reasoning_content: m.reasoning_content,
        })),
      } as AgentSseEvent);
      const continueContext = typeof consoleContext === "string" ? consoleContext : "";
      for await (const event of agentLoopStream(state.projectRoot, state, continueContext, sessionId, { model, apiKey })) {
        await sendAndMaybeYeld(event);
        if (event.type === "browser_tool" || event.type === "done" || event.type === "error") break;
      }
      return res.end();
    }

    if (state.pendingPermission && state.pendingPermission.toolCallId === toolCallId) {
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
    if (cmdResult !== null) {
      const termSandbox = typeof toolResult === "string" && toolResult.trim() ? toolResult : undefined;
      sendEvent({
        type: "tool_end",
        toolName: permissionToolName || "run_in_terminal",
        toolResult: cmdResult,
        toolParams: permissionToolParams,
      } as AgentSseEvent);
    }

    const sendAndMaybeYeld = async (event: AgentSseEvent): Promise<boolean> => {
      sendEvent(event);
      if (event.type === "tool_start") {
        await new Promise<void>((r) => setImmediate(r));
      }
      return false;
    };

    const continueContext = typeof consoleContext === "string" ? consoleContext : "";
    for await (const event of agentLoopStream(state.projectRoot, state, continueContext, sessionId, { model, apiKey })) {
      await sendAndMaybeYeld(event);
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
  });
});

// ── Client state persistence (~/.h/store/client-state.json) ──
// Survives reinstalls because it's in the user's home directory.

app.get("/api/client/state", (_req, res) => {
  try {
    if (fs.existsSync(CLIENT_STATE_FILE)) {
      const raw = fs.readFileSync(CLIENT_STATE_FILE, "utf-8");
      res.json(JSON.parse(raw));
    } else {
      res.json({});
    }
  } catch {
    res.json({});
  }
});

app.post("/api/client/state", (req, res) => {
  try {
    const dir = path.dirname(CLIENT_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLIENT_STATE_FILE, JSON.stringify(req.body || {}), "utf-8");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save client state" });
  }
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
      name.toLowerCase().includes("h");

    // IDE services (the main H node process + electron)
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

// ── File Tracking endpoints ──
// Returns current tracking mode, Git availability, and mid-session detection status.
app.get("/api/file-tracking/status", (_req, res) => {
  try {
    const svc = getFileTrackingService();
    res.json(svc.getStatus());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Initialize file tracking for a workspace.
// The frontend calls this when a folder is opened.
app.post("/api/file-tracking/init", (req, res) => {
  try {
    const { workspacePath } = req.body || {};
    if (!workspacePath) {
      return res.status(400).json({ error: "workspacePath is required" });
    }
    const svc = getFileTrackingService();
    const status = svc.init(workspacePath);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Poll for Git availability — used by frontend periodic check.
// Returns { gitDetected: true } when Git has become available mid-session.
app.get("/api/file-tracking/git-detected", (_req, res) => {
  try {
    const svc = getFileTrackingService();
    const status = svc.getStatus();
    res.json({
      gitDetected: status.gitDetectedMidSession,
      mode: status.mode,
      gitAvailable: status.gitAvailable,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Switch from watcher mode to Git mode.
// Compares current state with Git's state, resolves differences, and switches.
app.post("/api/file-tracking/switch-to-git", (req, res) => {
  try {
    const svc = getFileTrackingService();
    const result = svc.switchToGit();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Get changed files — works in both modes.
app.get("/api/file-tracking/changes", (req, res) => {
  try {
    const svc = getFileTrackingService();
    const files = svc.getChangedFiles();
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Force refresh the file tree (re-scans in watcher mode).
app.post("/api/file-tracking/refresh", (_req, res) => {
  try {
    const svc = getFileTrackingService();
    svc.refreshFileTree();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Get file tree context for the agent's system prompt.
// First call returns a full tree snapshot; subsequent calls return patches only.
// The last-sent snapshot persists to disk (~/.h/file-tree-snapshot.json).
app.get("/api/file-tracking/file-tree-context", (_req, res) => {
  try {
    const svc = getFileTrackingService();
    const result = svc.getFileTreeContext();
    res.json({ text: result.text, isFull: result.isFull });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Reset the file tree snapshot so the next request sends a full tree again.
// Called when a new folder is opened to ensure fresh context.
app.post("/api/file-tracking/reset-snapshot", (_req, res) => {
  try {
    const svc = getFileTrackingService();
    svc.resetFileTreeSnapshot();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// ── LSP (Language Server) endpoints ──
import { getCompletions, getFileDiagnostics, getLspStatus, watchDiagnostics, notifyFileChange, getDiagnosticsForRoot } from "./lsp";

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
  if (result.ok === false) {
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

// ── LSP diagnostics – read cached diagnostics (used by read_problems tool) ──
app.get("/api/lsp/diagnostics", (req, res) => {
  try {
    const rootPath = String(req.query.rootPath || "");
    if (!rootPath) return res.json({ ok: false, error: "Missing rootPath" });
    const results = getDiagnosticsForRoot(rootPath);
    res.json({ ok: true, diagnostics: results });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
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

// ── File search ──
// Aligned with agent grep (agent.ts): regex matching, secret-file excludes,
// optional glob/subdir filtering, natural file-walk order.

// One-time check: is ripgrep available?
let _rgAvailable: boolean | null = null;
function rgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try { execSync("rg --version", { encoding: "utf8", timeout: 3000, stdio: "pipe" }); _rgAvailable = true; }
  catch { _rgAvailable = false; }
  return _rgAvailable;
}

app.get("/api/search", (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const root = String(req.query.root || process.cwd());
    const glob = String(req.query.glob || "").trim();
    const subdir = String(req.query.subdir || "").trim();
    if (!q || q.length < 2) return res.json({ results: [], query: q });

    const resultLimit = 500;
    const results: Array<{ file: string; line: number; text: string }> = [];
    const searchRoot = subdir ? path.resolve(root, subdir) : root;

    // ── ripgrep content search ──
    let usedFallback = !rgAvailable();
    if (rgAvailable()) {
      try {
        // Build glob include filter if present (e.g. "*.ts" -> -g '*.ts')
        const globArgs = glob ? `-g ${JSON.stringify(glob)}` : "";
        const cmd = [
          "rg", "--no-heading", "-n", "-i",
          "--no-ignore-vcs",
          // Dir excludes (matching agent's node_modules/.git + common build/virtual env dirs)
          "-g", "'!**/.git/**'",
          "-g", "'!**/node_modules/**'",
          "-g", "'!**/dist/**'",
          "-g", "'!**/.next/**'",
          "-g", "'!**/venv/**'",
          "-g", "'!**/.venv/**'",
          "-g", "'!**/__pycache__/**'",
          "-g", "'!**/.pytest_cache/**'",
          "-g", "'!**/env/**'",
          // Secret-file excludes (matching agent's SECRET_PATTERNS)
          "-g", "'!*.env*'",
          "-g", "'!*.key'",
          "-g", "'!*.pem'",
          "-g", "'!*.p12'",
          "-g", "'!*.pfx'",
          // Binary / generated file excludes
          "-g", "'!*.min.js'",
          "-g", "'!*.map'",
          "-g", "'!*.lock'",
          "-g", "'!*.pyc'",
          "-g", "'!*.png'",
          "-g", "'!*.jpg'",
          "-g", "'!*.gif'",
          "-g", "'!*.ico'",
          "-g", "'!*.woff*'",
          globArgs,
          JSON.stringify(q),
        ].filter(Boolean).join(" ");
        const raw = execSync(cmd, { encoding: "utf8", timeout: 10000, cwd: searchRoot }).trim();
        if (raw) {
          for (const line of raw.split(/\r?\n/)) {
            if (results.length >= resultLimit) break;
            const m = line.match(/^(.+?):(\d+):(.*)$/);
            if (m) results.push({ file: m[1], line: parseInt(m[2], 10), text: m[3].substring(0, 120) });
          }
        }
      } catch {
        // rg timed out or errored — fall back to Node.js
        usedFallback = true;
      }
    }
    if (usedFallback) {
      results.length = 0;
      let regex: RegExp;
      try { regex = new RegExp(q, "gi"); } catch { regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); }

      function searchDir(dir: string) {
        if (results.length >= resultLimit) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= resultLimit) break;
          const full = path.join(dir, e.name);
          // Dir excludes — matching agent: only .git + node_modules + build/virtual env dirs
          if (e.isDirectory()) {
            const skip = [".git", "node_modules", "dist", ".next", "venv", ".venv", "__pycache__", ".pytest_cache", "env", ".vscode", "target"];
            if (!skip.includes(e.name)) searchDir(full);
            continue;
          }
          // Secret-file guard (matches agent's SECRET_PATTERNS)
          const lowerName = e.name.toLowerCase();
          if (/\.env$/i.test(e.name) || /\.env\..*$/i.test(e.name)) continue;
          if (/credentials|secret/i.test(e.name)) continue;
          if (/\.(key|pem|p12|pfx)$/i.test(e.name)) continue;
          if (/config\/.*(secret|key)/i.test(path.relative(searchRoot, full))) continue;
          // Glob filter
          if (glob) {
            const ext = path.extname(e.name).toLowerCase();
            if (glob.startsWith("*.")) { if (ext !== glob.slice(1).toLowerCase()) continue; }
            else if (glob.startsWith(".")) { if (ext !== glob.toLowerCase()) continue; }
            else if (!lowerName.includes(glob.toLowerCase())) continue;
          }
          // Skip binary / generated files
          if (/\.(min\.js|map|lock|pyc|png|jpg|jpeg|gif|ico|woff2?|ttf|eot)$/i.test(e.name)) continue;
          // Check filename match (in addition to content)
          let nameMatch = false;
          try { nameMatch = new RegExp(q, "i").test(e.name); } catch {}
          try {
            const text = fs.readFileSync(full, "utf-8");
            const lines = text.split("\n");
            let found = false;
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= resultLimit) return;
              if (regex.test(lines[i])) {
                regex.lastIndex = 0;
                const rel = path.relative(searchRoot, full).replace(/\\/g, "/");
                results.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 120) });
                found = true;
              }
            }
            // Fallback: if filename matches but no content match, add first line
            if (!found && nameMatch) {
              const rel = path.relative(searchRoot, full).replace(/\\/g, "/");
              const firstLine = lines.find((l) => l.trim()) || "";
              results.push({ file: rel, line: 1, text: firstLine.slice(0, 120) });
            }
          } catch { /* binary / unreadable */ }
        }
      }
      searchDir(searchRoot);
    }

    // ── Filename matches ──
    // Also include files whose name matches the query (content grep only searches body).
    // Deduplicate: skip files already found via content search.
    if (rgAvailable()) {
      const seenFiles = new Set(results.map((r) => r.file));
      try {
        const nameCmd = [
          "rg", "--files", "--no-ignore-vcs",
          "-g", "'!**/.git/**'",
          "-g", "'!**/node_modules/**'",
          "-g", "'!**/dist/**'",
          "-g", "'!**/.next/**'",
          "-g", "'!**/venv/**'",
          "-g", "'!**/.venv/**'",
          "-g", "'!**/__pycache__/**'",
          "-g", "'!**/.pytest_cache/**'",
          "-g", "'!**/env/**'",
          "-g", "'!*.env*'",
          "-g", "'!*.key'", "-g", "'!*.pem'", "-g", "'!*.p12'", "-g", "'!*.pfx'",
          "-g", "'!*.min.js'", "-g", "'!*.map'", "-g", "'!*.lock'", "-g", "'!*.pyc'",
          "-g", "'!*.png'", "-g", "'!*.jpg'", "-g", "'!*.gif'", "-g", "'!*.ico'", "-g", "'!*.woff*'",
          "--iglob", `'*${q.replace(/'/g, "'\\''")}*'`,
        ].join(" ");
        const nameRaw = execSync(nameCmd, { encoding: "utf8", timeout: 5000, cwd: searchRoot }).trim();
        if (nameRaw) {
          for (const filePath of nameRaw.split(/\r?\n/)) {
            if (results.length >= resultLimit) break;
            const rel = filePath.trim();
            if (!rel || seenFiles.has(rel)) continue;
            seenFiles.add(rel);
            try {
              const content = fs.readFileSync(path.join(searchRoot, rel), "utf8");
              const firstLine = content.split(/\r?\n/).find((l) => l.trim()) || "";
              results.push({ file: rel, line: 1, text: firstLine.slice(0, 120) });
            } catch {
              results.push({ file: rel, line: 0, text: "" });
            }
          }
        }
      } catch { /* rg --files failed — skip filename matching */ }
    }

    res.json({ results: results.slice(0, resultLimit), query: q });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Health check ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", pid: process.pid });
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
    '<div class="card">' + secHeader("disk-h", "H Components", "", !!collapsed["disk-h"]) +
    '<div class="sec-body"' + (collapsed["disk-h"] ? ' style="display:none"' : '') + '>' +
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

// ── Settings page ──
app.get("/settings", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Settings</title>\n<style>\n  :root { color-scheme: dark; }\n  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #1e1e1e; color: #d4d4d4; font-size: 13px; }\n  .wrap { display: flex; flex-direction: column; height: 100vh; }\n  .header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #1a1a1a; border-bottom: 1px solid #333; flex-shrink: 0; }\n  .header h1 { font-size: 14px; font-weight: 600; margin: 0; color: #d4d4d4; }\n  .tabs { display: flex; flex-shrink: 0; border-bottom: 1px solid #333; background: #1a1a1a; }\n  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: #888; padding: 8px 16px; font-size: 12px; font-family: inherit; cursor: pointer; transition: color .15s, border-color .15s; display: flex; align-items: center; gap: 6px; }\n  .tab:hover { color: #d4d4d4; }\n  .tab.active { color: #d4d4d4; border-bottom-color: #4D6BFE; }\n  .tab svg { width: 14px; height: 14px; }\n  .body { flex: 1; overflow-y: auto; padding: 16px; }\n  .section { margin-bottom: 20px; }\n  .section-title { font-size: 11px; font-weight: 600; color: #999; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .5px; }\n  .label { display: block; font-size: 11px; font-weight: 600; color: #999; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }\n  .input { width: 100%; box-sizing: border-box; background: #2d2d2d; border: 1px solid #444; border-radius: 4px; color: #d4d4d4; padding: 7px 10px; font-size: 12px; font-family: monospace; outline: none; }\n  .input:focus { border-color: #4D6BFE; }\n  .input-row { display: flex; gap: 8px; }\n  .input-row .input { flex: 1; }\n  .btn { border: none; border-radius: 4px; padding: 7px 14px; font-size: 12px; font-family: inherit; cursor: pointer; font-weight: 500; transition: background .15s; white-space: nowrap; }\n  .btn:disabled { opacity: 0.5; cursor: default; }\n  .btn-primary { background: #4D6BFE; color: #fff; }\n  .btn-primary:hover:not(:disabled) { background: #3d5be0; }\n  .btn-danger { background: #c0392b; color: #fff; }\n  .btn-danger:hover:not(:disabled) { background: #a93226; }\n  .btn-small { padding: 4px 10px; font-size: 11px; }\n  .btn-icon { background: none; border: none; color: #888; padding: 3px 5px; cursor: pointer; border-radius: 3px; font-size: 14px; line-height: 1; }\n  .btn-icon:hover { color: #d4d4d4; background: rgba(255,255,255,0.06); }\n  .btn-icon.del:hover { color: #e74c3c; }\n  .hint { font-size: 11px; color: #666; margin: 6px 0 0; }\n  .hint a { color: #4D6BFE; text-decoration: none; }\n  .hint a:hover { text-decoration: underline; }\n  .status { font-size: 11px; margin-top: 8px; }\n  .status-ok { color: #4ec94e; }\n  .status-err { color: #e74c3c; }\n  .key-status { display: flex; align-items: center; gap: 10px; }\n  .key-indicator { color: #4ec94e; font-size: 12px; display: flex; align-items: center; gap: 4px; }\n  .toggle-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; }\n  .toggle-label input[type=checkbox] { accent-color: #4D6BFE; width: 15px; height: 15px; }\n  .loading { padding: 24px; text-align: center; color: #888; font-size: 12px; }\n  .divider { border: none; border-top: 1px solid #333; margin: 14px 0; }\n  /* Current config card */\n  .config-card { background: #252526; border: 1px solid #333; border-radius: 6px; padding: 12px; margin-bottom: 16px; }\n  .config-card .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }\n  .config-card .row-label { color: #888; min-width: 70px; }\n  .config-card .row-value { font-family: monospace; }\n  /* Mode badge */\n  .mode-badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 3px; background: rgba(77,107,254,0.15); color: #4D6BFE; }\n  .mode-badge.chat { background: rgba(78,201,78,0.12); color: #4ec94e; }\n  /* Preset rows */\n  .preset-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #252526; border: 1px solid #333; border-radius: 4px; margin-bottom: 4px; }\n  .preset-row:hover { border-color: #555; }\n  .preset-row.active { border-color: #4D6BFE; }\n  .preset-name { flex: 1; font-family: monospace; font-size: 12px; }\n  .preset-active-badge { font-size: 10px; color: #4ec94e; }\n  .empty-hint { color: #666; font-style: italic; font-size: 12px; padding: 4px 0; }\n  /* Save row */\n  .save-row { display: flex; gap: 8px; margin-top: 8px; }\n  .btn-green { background: #4ec94e; color: #fff; }\n  .btn-green:hover:not(:disabled) { background: #3da83d; }\n  /* About */\n  .about-header { display: flex; flex-direction: column; align-items: center; padding: 20px 0; }\n  .about-logo { width: 48px; height: 48px; margin-bottom: 10px; }\n  .about-title { font-size: 18px; font-weight: 600; margin: 0 0 2px; }\n  .about-subtitle { font-size: 12px; color: #888; margin: 0 0 6px; }\n  .about-version { font-size: 11px; color: #666; }\n  .about-section-btn { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: none; border-top: 1px solid #333; color: #bbb; padding: 10px 12px; font-size: 12px; font-family: inherit; cursor: pointer; text-align: left; }\n  .about-section-btn:hover { background: rgba(255,255,255,0.02); }\n  .about-section-btn.active { color: #4D6BFE; }\n  .about-section-btn .chevron { font-size: 9px; color: #888; width: 12px; flex-shrink: 0; }\n  .about-text { padding: 0 16px 16px; font-size: 12px; color: #999; line-height: 1.6; border-top: 1px solid #2a2a2a; }\n  .about-text h4 { color: #bbb; font-size: 12px; margin: 12px 0 4px; }\n  .about-text h4:first-child { margin-top: 8px; }\n  .about-text p { margin: 4px 0; }\n  .about-text ul { margin: 4px 0; padding-left: 18px; }\n  .about-text li { margin: 2px 0; }\n  .about-text code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 2px; font-size: 10px; }\n  .about-text a { color: #4D6BFE; text-decoration: none; }\n  .about-text a:hover { text-decoration: underline; }\n  .oss-list { list-style: none; padding-left: 0; }\n  .oss-list li { padding: 2px 0; }\n</style>\n</head>\n<body>\n<div class="wrap">\n  <div class="header"><h1>Settings</h1></div>\n  <div class="tabs">\n    <button class="tab active" data-tab="model" onclick="switchTab(\'model\')">\n      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h5.71a3.59 3.59 0 0 1 2.9 1.63L12.43 7H14a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-1a2 2 0 0 1-4 0H6a2 2 0 0 1-4 0H1a1 1 0 0 1-1-1V9a2 2 0 0 1 2-2V2zm10.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM13 8H7.5l-2 3H2V7h10v1z"/></svg>\n      Model &amp; API Key\n    </button>\n    <button class="tab" data-tab="about" onclick="switchTab(\'about\')">\n      <svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.568.447a1.13 1.13 0 0 0-1.136 0L1.32 4.006A1.13 1.13 0 0 0 .75 4.98v5.04c0 .412.223.79.57.974l6.112 3.56c.349.203.787.203 1.136 0l6.112-3.56c.347-.184.57-.562.57-.974V4.98c0-.412-.223-.79-.57-.974L8.568.447zM8 1.39l6 3.495v5.23L8 13.61l-6-3.495v-5.23L8 1.39zM9 5H7v2h2V5zm0 3H7v3h2V8z"/></svg>\n      About\n    </button>\n  </div>\n  <div class="body" id="body">\n    <div class="loading">Loading...</div>\n  </div>\n</div>\n<script>\nvar currentTab = "model";\nvar configChecked = false;\nvar hasApiKey = false;\nvar apiKeySource = "none";\nvar statusText = "";\nvar presets = [];\nvar activePresetId = null;\nvar showEditConfig = false;\nvar showAddConfig = false;\n\nfunction loadPresets() {\n  try {\n    presets = JSON.parse(localStorage.getItem("h-presets") || "[]");\n  } catch(e) { presets = []; }\n  activePresetId = localStorage.getItem("h-active-preset") || null;\n}\nloadPresets();\n\nfunction switchTab(t) {\n  currentTab = t;\n  document.querySelectorAll(".tab").forEach(function(el) {\n    el.classList.toggle("active", el.dataset.tab === t);\n  });\n  render();\n}\n\nfunction html(str) {\n  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");\n}\n\nfunction render() {\n  var body = document.getElementById("body");\n  if (currentTab === "model") {\n    body.innerHTML = getModelTabHtml();\n    afterModelRender();\n  } else {\n    body.innerHTML = getAboutTabHtml();\n    afterAboutRender();\n  }\n}\n\n// ── Model Tab ──\nfunction getModelTabHtml() {\n  if (!configChecked) {\n    return \'<div class="loading">Loading configuration...</div>\';\n  }\n  var model = localStorage.getItem("h-model") || "";\n  var thinking = localStorage.getItem("h-thinking") === "true";\n  var apiKeyRow;\n  if (hasApiKey) {\n    apiKeyRow = \'<div class="key-status"><span class="key-indicator">&#10003; API key configured</span><button class="btn btn-danger btn-small" onclick="clearApiKey()">Remove Key</button></div>\';\n  } else {\n    apiKeyRow = \'<div class="input-row"><input class="input" type="password" id="apiKeyInput" placeholder="sk-..." onkeydown="if(event.key===\\\'Enter\\\')saveApiKey()" /><button class="btn btn-primary" id="saveKeyBtn" onclick="saveApiKey()">Save Key</button></div>\';\n  }\n\n  // Current configuration card (shown when a model is active)\n  var currentConfigHtml = model ? \'<div class="config-card">\'\n    + \'<div class="row"><span class="row-label">Model</span><span class="row-value">\' + html(model) + \'</span></div>\'\n    + \'<div class="row"><span class="row-label">Mode</span><span class="mode-badge \' + (thinking ? "" : "chat") + \'">\' + (thinking ? "Thinking" : "Chat") + \'</span></div>\'\n    + \'<div class="row"><span class="row-label">API Key</span><span style="color:\' + (hasApiKey ? "#4ec94e" : "#d29922") + \'">\' + (hasApiKey ? "Configured" : "Not configured") + \'</span></div>\'\n    + \'</div>\' : \'<div class="empty-hint" style="padding:8px 0">Select a saved configuration or add a new one.</div>\';\n\n  // Saved Presets section\n  var presetsHtml = \'<div class="section"><div class="section-title">Saved Configurations</div>\';\n  if (presets.length > 0) {\n    for (var i = 0; i < presets.length; i++) {\n      var p = presets[i];\n      var isActive = activePresetId === p.id;\n      presetsHtml += \'<div class="preset-row \' + (isActive ? "active" : "") + \'" onclick="editPreset(\\\'\' + p.id + \'\\\')" style="cursor:pointer">\'\n        + \'<span class="preset-name">\' + html(p.model) + \'</span>\'\n        + \'<span class="mode-badge \' + (p.thinking ? "" : "chat") + \'">\' + (p.thinking ? "Think" : "Chat") + \'</span>\'\n        + (isActive ? \'<span class="preset-active-badge">&#10003; Active</span>\' : "")\n        + \'<button class="btn-icon" onclick="event.stopPropagation();editPreset(\\\'\' + p.id + \'\\\')" title="Edit">&#9998;</button>\'\n        + \'<button class="btn-icon del" onclick="event.stopPropagation();deletePreset(\\\'\' + p.id + \'\\\')" title="Delete">&#10005;</button>\'\n        + \'</div>\';\n    }\n  } else {\n    presetsHtml += \'<div class="empty-hint">No saved configurations. Set model and mode below, then save as a preset.</div>\';\n  }\n  presetsHtml += \'</div>\';\n  presetsHtml += \'<button class="btn" style="background:#3c3c3c;color:#d4d4d4;margin-top:6px;width:100%" onclick="addConfiguration()">+ Add Configuration</button>\';\n\n  // Edit Configuration section (shown when editing a preset)\n  var editSectionHtml = showEditConfig ? \'<div class="section"><div class="section-title">Edit Configuration</div>\'\n    + \'<div style="margin-bottom:12px"><span class="label">Model</span><div class="input-row"><input class="input" id="modelInput" value="\' + html(model) + \'" placeholder="e.g. deepseek-v4-pro" /></div><p class="hint">Model identifier used for agent requests.</p></div>\'\n    + \'<div style="margin-bottom:12px"><span class="label">Thinking Mode</span><label class="toggle-label"><input type="checkbox" id="thinkToggle" \' + (thinking ? "checked" : "") + \' onchange="toggleThinking()" /><span>Enable reasoning/thinking output</span></label></div>\'\n    + \'<div class="save-row"><button class="btn btn-green" id="savePresetBtn" onclick="saveAsPreset()">&#128190; Save as Preset</button><button class="btn btn-primary" onclick="saveModelAsNew()">Save Model as New</button><button class="btn" style="background:#555" onclick="cancelEdit()">Cancel</button></div>\'\n    + \'</div>\' : "";\n\n  // Add Configuration section (shown when adding new)\n  var addSectionHtml = showAddConfig ? \'<div class="section"><div class="section-title">Add Configuration</div>\'\n    + \'<div style="margin-bottom:12px"><span class="label">Model</span><div class="input-row"><input class="input" id="modelInput" value="\' + html(model) + \'" placeholder="e.g. deepseek-v4-pro" /></div><p class="hint">Model identifier used for agent requests.</p></div>\'\n    + \'<div style="margin-bottom:12px"><span class="label">Thinking Mode</span><label class="toggle-label"><input type="checkbox" id="thinkToggle" \' + (thinking ? "checked" : "") + \' onchange="toggleThinking()" /><span>Enable reasoning/thinking output</span></label></div>\'\n    + \'<div class="save-row"><button class="btn btn-green" onclick="saveModelAsNew()">&#128190; Save Model</button><button class="btn" style="background:#555" onclick="cancelAdd()">Cancel</button></div>\'\n    + \'</div>\' : "";\n\n  return currentConfigHtml + presetsHtml + editSectionHtml + addSectionHtml + \'<div class="divider"></div>\' + \'<div class="section"><div class="section-title">DeepSeek API Key</div>\' + apiKeyRow + \'<p class="hint">Your API key is encrypted at rest (AES-256-GCM) and never stored in browser localStorage. Get a key at <a href="https://platform.deepseek.com/api_keys" target="_blank">platform.deepseek.com</a>.</p>\' + (statusText ? \'<p class="status \' + (statusText.indexOf("Error") === 0 ? "status-err" : "status-ok") + \'">\' + html(statusText) + \'</p>\' : "") + \'</div>\';\n}\n\nfunction afterModelRender() {\n  var btn = document.getElementById("saveKeyBtn");\n  var inp = document.getElementById("apiKeyInput");\n  if (btn && inp) {\n    btn.disabled = !inp.value.trim();\n    inp.addEventListener("input", function() { btn.disabled = !inp.value.trim(); });\n  }\n}\n\nfunction saveModelAsNew() {\n  var model = document.getElementById("modelInput").value.trim();\n  if (!model) { statusText = "Model name cannot be empty."; render(); return; }\n  var thinking = document.getElementById("thinkToggle").checked;\n  localStorage.setItem("h-model", model);\n  localStorage.setItem("h-thinking", String(thinking));\n  var id = "preset-" + Date.now();\n  presets.push({ id: id, model: model, thinking: thinking });\n  activePresetId = id;\n  localStorage.setItem("h-presets", JSON.stringify(presets));\n  localStorage.setItem("h-active-preset", id);\n  showEditConfig = false;\n  showAddConfig = false;\n  statusText = "Model saved as new preset.";\n  render();\n}\n\nfunction addConfiguration() {\n  activePresetId = null;\n  localStorage.removeItem("h-active-preset");\n  localStorage.setItem("h-model", "");\n  localStorage.setItem("h-thinking", "false");\n  showEditConfig = false;\n  showAddConfig = true;\n  statusText = "";\n  render();\n}\n\nfunction cancelEdit() {\n  showEditConfig = false;\n  loadPresets();\n  render();\n}\n\nfunction cancelAdd() {\n  showAddConfig = false;\n  loadPresets();\n  render();\n}\n\nfunction toggleThinking() {\n  var v = document.getElementById("thinkToggle").checked;\n  localStorage.setItem("h-thinking", String(v));\n}\n\nfunction saveAsPreset() {\n  var model = document.getElementById("modelInput").value.trim();\n  if (!model) { statusText = "Model name cannot be empty."; render(); return; }\n  var thinking = document.getElementById("thinkToggle").checked;\n  localStorage.setItem("h-model", model);\n  localStorage.setItem("h-thinking", String(thinking));\n  if (activePresetId) {\n    for (var i = 0; i < presets.length; i++) {\n      if (presets[i].id === activePresetId) {\n        presets[i].model = model;\n        presets[i].thinking = thinking;\n        break;\n      }\n    }\n  } else {\n    var id = "preset-" + Date.now();\n    presets.push({ id: id, model: model, thinking: thinking });\n    activePresetId = id;\n    localStorage.setItem("h-active-preset", id);\n  }\n  localStorage.setItem("h-presets", JSON.stringify(presets));\n  showEditConfig = false;\n  showAddConfig = false;\n  statusText = "Preset saved.";\n  render();\n}\n\nfunction editPreset(id) {\n  for (var i = 0; i < presets.length; i++) {\n    if (presets[i].id === id) {\n      activePresetId = id;\n      localStorage.setItem("h-active-preset", id);\n      localStorage.setItem("h-model", presets[i].model);\n      localStorage.setItem("h-thinking", String(presets[i].thinking));\n      break;\n    }\n  }\n  loadPresets();\n  showEditConfig = true;\n  showAddConfig = false;\n  render();\n}\n\nfunction deletePreset(id) {\n  if (!confirm("Delete this saved configuration?")) return;\n  presets = presets.filter(function(p) { return p.id !== id; });\n  localStorage.setItem("h-presets", JSON.stringify(presets));\n  if (activePresetId === id) {\n    activePresetId = null;\n    localStorage.removeItem("h-active-preset");\n    localStorage.removeItem("h-model");\n    localStorage.removeItem("h-thinking");\n  }\n  showEditConfig = false;\n  if (presets.length === 0) {\n    activePresetId = null;\n    localStorage.removeItem("h-active-preset");\n    localStorage.setItem("h-model", "");\n    localStorage.setItem("h-thinking", "false");\n    showAddConfig = true;\n  }\n  statusText = "Preset deleted.";\n  render();\n}\n\nasync function saveApiKey() {\n  var inp = document.getElementById("apiKeyInput");\n  var key = inp.value.trim();\n  if (!key) { statusText = "API key cannot be empty."; render(); return; }\n  statusText = "Saving...";\n  render();\n  try {\n    var res = await fetch("/api/chat/agent/credentials", {\n      method: "POST",\n      headers: { "Content-Type": "application/json" },\n      body: JSON.stringify({ apiKey: key }),\n    });\n    if (!res.ok) {\n      var d = await res.json().catch(function() { return {}; });\n      throw new Error(d.error || "HTTP " + res.status);\n    }\n    hasApiKey = true;\n    apiKeySource = "session";\n    localStorage.setItem("h-api-key-changed", Date.now());\n    statusText = "API key saved successfully.";\n  } catch (e) {\n    statusText = "Error: " + e.message;\n  }\n  render();\n}\n\nasync function clearApiKey() {\n  if (!confirm("Remove the API key? You will need to re-enter it to use agent features.")) return;\n  statusText = "Removing...";\n  render();\n  try {\n    var res = await fetch("/api/chat/agent/credentials", { method: "DELETE" });\n    if (!res.ok) {\n      var d = await res.json().catch(function() { return {}; });\n      throw new Error(d.error || "HTTP " + res.status);\n    }\n    hasApiKey = false;\n    apiKeySource = "none";\n    localStorage.setItem("h-api-key-changed", Date.now());\n    statusText = "API key removed.";\n  } catch (e) {\n    statusText = "Error: " + e.message;\n  }\n  render();\n}\n\n// ── About Tab ──\nvar aboutOpen = "";\n\nfunction getAboutTabHtml() {\n  return \'<div class="about-header">\'\n    + \'<svg class="about-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="2" width="5.5" height="20" rx="2.75" fill="#4D6BFE"/><rect x="15.5" y="2" width="5.5" height="20" rx="2.75" fill="#4D6BFE"/><rect x="3" y="9.5" width="18" height="5" rx="2.5" fill="#4D6BFE"/></svg>\'\n    + \'<h2 class="about-title"></h2>\'\n    + \'<p class="about-subtitle">AI-powered coding workspace<br />Powered by DeepSeek</p>\'\n    + \'<p class="about-version">Version 0.0.1</p>\'\n    + \'</div>\'\n    + aboutSection("terms", "Terms of Service", getTermsHtml())\n    + aboutSection("privacy", "Privacy Policy", getPrivacyHtml())\n    + aboutSection("oss", "Open Source Software Statement", getOssHtml());\n}\n\nfunction aboutSection(id, title, content) {\n  var open = aboutOpen === id;\n  return \'<button class="about-section-btn \' + (open ? "active" : "") + \'" onclick="toggleAbout(\\\'\' + id + \'\\\')"><span class="chevron">\' + (open ? "\\u25be" : "\\u25b8") + \'</span>\' + html(title) + \'</button>\' + (open ? \'<div class="about-text">\' + content + \'</div>\' : "");\n}\n\nfunction toggleAbout(id) {\n  aboutOpen = aboutOpen === id ? "" : id;\n  render();\n}\n\nfunction getTermsHtml() {\n  return \'<p><strong>Last updated: July 2026</strong></p>\'\n    + \'<p>By using H ("the Software"), you agree to these terms.</p>\'\n    + \'<h4>1. License</h4>\'\n    + \'<p>The Software is provided for personal and commercial use. You may install, run, and use the Software on any number of devices you own or control.</p>\'\n    + \'<h4>2. AI Services</h4>\'\n    + \'<p>The Software integrates with third-party AI API providers (such as DeepSeek). Use of AI features requires a valid API key from the respective provider. You are responsible for all API usage costs, compliance with the provider\\\'s terms, and any content generated through AI interactions.</p>\'\n    + \'<h4>3. User Responsibilities</h4>\'\n    + \'<p>You are responsible for:</p>\'\n    + \'<ul><li>All code, files, and content you create or modify using the Software.</li><li>Keeping your API keys secure and confidential.</li><li>Complying with all applicable laws and regulations.</li></ul>\'\n    + \'<h4>4. Disclaimer</h4>\'\n    + \'<p>THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. AI-GENERATED CONTENT MAY BE INACCURATE OR INCOMPLETE. ALWAYS REVIEW AI OUTPUT BEFORE USE.</p>\'\n    + \'<h4>5. Limitation of Liability</h4>\'\n    + \'<p>In no event shall the authors be liable for any damages arising from the use or inability to use the Software, including but not limited to data loss, API costs, or damages resulting from AI-generated code.</p>\';\n}\n\nfunction getPrivacyHtml() {\n  return \'<p><strong>Last updated: July 2026</strong></p>\'\n    + \'<h4>1. Data Collection</h4>\'\n    + \'<p>H does <strong>not</strong> collect telemetry, analytics, or usage data. No data is sent to H developers or any third-party analytics services.</p>\'\n    + \'<h4>2. Data Storage</h4>\'\n    + \'<p>All user data is stored locally on your machine:</p>\'\n    + \'<ul><li><strong>API keys</strong> &mdash; Encrypted with AES-256-GCM using a machine-specific key at <code>~/.h/store/api-keys.enc</code>. Never stored in browser localStorage. Transmitted only to DeepSeek API as Bearer token.</li>\'\n    + \'<li><strong>Chat history &amp; preferences</strong> &mdash; Stored in browser localStorage, synced to <code>~/.h/store/client-state.json</code> on disk.</li>\'\n    + \'<li><strong>Agent memory</strong> &mdash; SQLite database at <code>~/.h/store/memory.db</code> (WAL mode).</li>\'\n    + \'<li><strong>File tracking metadata</strong> &mdash; <code>~/.h/store/file-tracking.json</code> (file paths, sizes, checksums; no file contents).</li>\'\n    + \'<li><strong>Port discovery files</strong> &mdash; OS temp directory; runtime only, not persisted.</li></ul>\'\n    + \'<p>Deleting <code>~/.h/</code> removes all H data.</p>\'\n    + \'<h4>3. External Data Transmission</h4>\'\n    + \'<p>Project source code (files, file tree, prompts) is transmitted to DeepSeek\\\'s API (<code>api.deepseek.com</code>) as part of agent operations. No code is transmitted anywhere else.</p>\'\n    + \'<h4>4. Your Rights</h4>\'\n    + \'<p>All data resides on your machine. You can delete all data by removing the <code>~/.h/</code> directory. API keys can be removed at any time via Settings.</p>\';\n}\n\nfunction getOssHtml() {\n  return \'<p>This product includes software developed by the following open source projects:</p>\'\n    + \'<h4>Runtime Dependencies</h4>\'\n    + \'<ul class="oss-list">\'\n    + \'<li><strong>React</strong> (MIT) &mdash; <a href="https://react.dev" target="_blank">react.dev</a></li>\'\n    + \'<li><strong>Express</strong> (MIT) &mdash; <a href="https://expressjs.com" target="_blank">expressjs.com</a></li>\'\n    + \'<li><strong>Monaco Editor</strong> (MIT) &mdash; <a href="https://microsoft.github.io/monaco-editor/" target="_blank">microsoft.github.io/monaco-editor</a></li>\'\n    + \'<li><strong>xterm.js</strong> (MIT) &mdash; <a href="https://xtermjs.org" target="_blank">xtermjs.org</a></li>\'\n    + \'<li><strong>TypeScript</strong> (Apache-2.0) &mdash; <a href="https://www.typescriptlang.org" target="_blank">typescriptlang.org</a></li>\'\n    + \'<li><strong>Vite</strong> (MIT) &mdash; <a href="https://vitejs.dev" target="_blank">vitejs.dev</a></li>\'\n    + \'<li><strong>Electron</strong> (MIT) &mdash; <a href="https://www.electronjs.org" target="_blank">electronjs.org</a></li>\'\n    + \'<li><strong>better-sqlite3</strong> (MIT) &mdash; <a href="https://github.com/WiseLibs/better-sqlite3" target="_blank">github.com/WiseLibs/better-sqlite3</a></li>\'\n    + \'<li><strong>node-pty</strong> (MIT) &mdash; <a href="https://github.com/lydell/node-pty" target="_blank">github.com/lydell/node-pty</a></li>\'\n    + \'<li><strong>dotenv</strong> (BSD-2-Clause) &mdash; <a href="https://github.com/motdotla/dotenv" target="_blank">github.com/motdotla/dotenv</a></li>\'\n    + \'<li><strong>ws</strong> (MIT) &mdash; <a href="https://github.com/websockets/ws" target="_blank">github.com/websockets/ws</a></li>\'\n    + \'<li><strong>tsx</strong> (MIT) &mdash; <a href="https://github.com/privatenumber/tsx" target="_blank">github.com/privatenumber/tsx</a></li>\'\n    + \'<li><strong>material-icon-theme</strong> (MIT) &mdash; File icons</li>\'\n    + \'<li><strong>@vscode/codicons</strong> (CC-BY-4.0) &mdash; Icon font</li>\'\n    + \'</ul>\'\n    + \'<h4>Development Dependencies</h4>\'\n    + \'<ul class="oss-list">\'\n    + \'<li><strong>electron-builder</strong> (MIT)</li>\'\n    + \'<li><strong>electron-rebuild</strong> (MIT)</li>\'\n    + \'<li><strong>Vitest</strong> (MIT)</li>\'\n    + \'<li><strong>Supertest</strong> (MIT)</li>\'\n    + \'<li><strong>sharp</strong> (Apache-2.0)</li>\'\n    + \'<li><strong>concurrently</strong> (MIT)</li>\'\n    + \'<li><strong>png-to-ico</strong> (MIT)</li>\'\n    + \'<li><strong>to-ico</strong> (MIT)</li>\'\n    + \'<li><strong>rcedit</strong> (MIT)</li>\'\n    + \'</ul>\'\n    + \'<p style="margin-top:12px;font-style:italic">Full license texts are available in each package\\\'s <code>node_modules/&lt;package&gt;/LICENSE</code> file.</p>\';\n}\n\nfunction afterAboutRender() {}\n\n// ── Init ──\n(async function init() {\n  try {\n    var res = await fetch("/api/chat/agent/config");\n    var data = await res.json();\n    hasApiKey = Boolean(data.apiKeyConfigured);\n    apiKeySource = data.source || "none";\n  } catch(e) { hasApiKey = false; apiKeySource = "none"; }\n  configChecked = true;\n  if (presets.length === 0 && !hasApiKey) { showAddConfig = true; }\n  render();\n})();\n\n// Listen for localStorage changes from other windows (e.g. main IDE)\nwindow.addEventListener("storage", function(e) {\n  if (e.key === "h-presets" || e.key === "h-active-preset" || e.key === "h-model" || e.key === "h-thinking") {\n    loadPresets();\n    configChecked = true;\n    render();\n  }\n});\n</script>\n</body>\n</html>');
});

// ── MCP (Model Context Protocol) endpoints ──
import { HMcpServer, handleMcpSseRequest } from "./mcp";

const mcpServer = new HMcpServer();

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

// ── Resolve project root ──
// Works from:
//   • dev source (server/index.ts inside project root next to package.json)
//   • compiled server in dist/server (tsc rootDir=., outDir=dist)
//   • PACKAGED build running from <resources>/app.asar.unpacked/dist/server:
//     asarUnpack copies in package.json guarantees package.json, client/dist, dist/server.
function resolveProjectRoot(): string {
  const dir = __dirname;

  // 1. Compiled dist/server: up twice → directory containing package.json. Works both for
  //    local dev runs (project root) AND packaged app.asar.unpacked/ — both have a
  //    package.json at the 2-parent level
  const compiledRoot = path.resolve(dir, "..", "..");
  if (fs.existsSync(path.join(compiledRoot, "package.json"))) return compiledRoot;

  // 2. Fallback: walk up looking for app.asar FILE (resources/<folder contains app.asar + app.asar.unpacked)
  let p = dir;
  for (let i = 0; i < 6; i++) {
    const asarPath = path.join(p, "app.asar");
    if (fs.existsSync(asarPath) && fs.statSync(asarPath).isFile()) {
      // Prefer <p>/app.asar.unpacked/ if that subdir also has a package.json (always
      // the case when asarUnpack includes it); otherwise fall back to asar FILE virtual
      // path readable only via asar-aware fs.
      const unpackedRoot = path.join(p, "app.asar.unpacked");
      if (fs.existsSync(path.join(unpackedRoot, "package.json"))) {
        return unpackedRoot;
      }
      return asarPath;
    }
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }

  // 3. Dev source (server/index.ts): up once → project root
  return path.resolve(dir, "..");
}
const PROJECT_ROOT = resolveProjectRoot();

// ── Serve client (desktop / production) ──
const clientDist = path.join(PROJECT_ROOT, "client", "dist");
if (process.env.H_SERVE_CLIENT === "1" && fs.existsSync(path.join(clientDist, "index.html"))) {
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
// Proxies any URL through the H server so the iframe is always same-origin.
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

  // Display-friendly title for proxied JSON pages (used below in HTML templates)
  const pageTitle = parsed.host + parsed.pathname;

  const client = parsed.protocol === "https:" ? https : http;

  const reqHeaders = { ...req.headers };
  delete reqHeaders.referer;
  delete reqHeaders.referrer;

  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...reqHeaders,
        host: parsed.host,
      },
    },
    (proxyRes) => {
      const headers: Record<string, string | string[] | undefined> = {
        ...proxyRes.headers,
      };
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];
      // Inject CSP to prevent proxied pages from accessing H APIs
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
          // If the response body looks like JSON (some APIs return HTML content-type for JSON),
          // render it with syntax highlighting instead of treating it as HTML.
          const trimmed = body.trim();
          if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 5_000_000) {
            try {
              const parsed = JSON.parse(body);
              const formatted = JSON.stringify(parsed, null, 2);
              headers["content-type"] = "text/html; charset=utf-8";
              const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${pageTitle}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1e1e1e;color:#d4d4d4;font:13px/1.5 'Cascadia Code','Fira Code',Consolas,monospace;padding:16px;white-space:pre-wrap;word-break:break-word}
.key{color:#8E9FFF}.str{color:#ce9178}.num{color:#b5cea8}.bool{color:#4D6BFE}.nil{color:#4D6BFE}.bracket{color:#ffd700}
</style></head><body>${highlightJson(formatted)}</body></html>`;
              res.writeHead(proxyRes.statusCode || 200, headers);
              res.end(html);
              return;
            } catch { /* not valid JSON, fall through to HTML injection */ }
          }
          // Normal HTML response: inject base tag
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
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${pageTitle}</title><style>
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
        // For unrecognized content types, sniff the body for JSON to avoid
        // rendering raw JSON as plain text (which may appear as white screen if
        // the content contains angle brackets interpreted as HTML tags).
        const proxyHeaders = { ...headers };
        let body = "";
        proxyRes.setEncoding("utf8");
        proxyRes.on("data", (chunk: string) => { body += chunk; });
        proxyRes.on("end", () => {
          const trimmed = body.trim();
          if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 5_000_000) {
            try {
              const parsed = JSON.parse(body);
              const formatted = JSON.stringify(parsed, null, 2);
              proxyHeaders["content-type"] = "text/html; charset=utf-8";
              const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${pageTitle}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1e1e1e;color:#d4d4d4;font:13px/1.5 'Cascadia Code','Fira Code',Consolas,monospace;padding:16px;white-space:pre-wrap;word-break:break-word}
.key{color:#8E9FFF}.str{color:#ce9178}.num{color:#b5cea8}.bool{color:#4D6BFE}.nil{color:#4D6BFE}.bracket{color:#ffd700}
</style></head><body>${highlightJson(formatted)}</body></html>`;
              res.writeHead(proxyRes.statusCode || 200, proxyHeaders);
              res.end(html);
              return;
            } catch { /* not valid JSON */ }
          }
          res.writeHead(proxyRes.statusCode || 200, proxyHeaders);
          res.end(body);
        });
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
  ws.send(JSON.stringify({ type: "log", data: "Connected to H server" }));

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

// ── Fixed port binding ──
// Default port with fallback range; avoids port-file writes/reads and race conditions.
// The client (Vite dev proxy + Electron packaged) should try ports in this range.
const EXPRESS_DEFAULT_PORT = 51734;
const EXPRESS_PORT_RANGE = 20; // try 51734..51753

function listenInRange(startPort: number, range: number, cb: (port: number) => void) {
  let attempts = 0;
  const tryPort = (p: number) => {
    attempts++;
    server.once("error", (err: any) => {
      if (err?.code === "EADDRINUSE" && attempts < range) {
        tryPort(p + 1);
      } else {
        console.error(`[h:server] Server error on port ${p}:`, err);
      }
    });
    server.listen(p, "127.0.0.1", () => {
      server.removeAllListeners("error");
      cb(p);
    });
  };
  tryPort(startPort);
}

export function getListenPortStart(): number { return EXPRESS_DEFAULT_PORT; }
export function getListenPortRange(): number { return EXPRESS_PORT_RANGE; }

if (process.env.NODE_ENV !== "test") {
  // Env override for explicit port (useful for deployments)
  const explicitPort = process.env.H_PORT ? parseInt(process.env.H_PORT, 10) : 0;
  if (explicitPort > 0) {
    server.listen(explicitPort, "127.0.0.1", () => {
      console.log(`H server running on http://localhost:${explicitPort}`);
    });
    server.on("error", (err) => {
      console.error(`[h:server] Server error:`, err);
    });
  } else {
    listenInRange(EXPRESS_DEFAULT_PORT, EXPRESS_PORT_RANGE, (port) => {
      console.log(`H server running on http://localhost:${port}`);
    });
  }
}

process.on("SIGINT", async () => {
  process.exit();
});
process.on("SIGTERM", async () => {
  process.exit();
});
