// ── API endpoint integration tests ──
// Tests Express REST endpoints using supertest.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DeepSeek before importing the server module
vi.mock("../deepseek", () => ({
  chatDeepSeek: vi.fn(),
  chatDeepSeekTool: vi.fn(),
  chatDeepSeekToolStream: vi.fn(),
}));

import { chatDeepSeekTool, chatDeepSeekToolStream } from "../deepseek";
import { app } from "../index";
import request from "supertest";

describe("API Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Health ──

  describe("GET /api/health", () => {
    it("returns status ok", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  // ── Agent chat (blocking) ──

  describe("POST /api/chat/agent", () => {
    it("returns 400 when message is missing", async () => {
      const res = await request(app)
        .post("/api/chat/agent")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing message");
    });

    it("returns phase:done with text reply", async () => {
      vi.mocked(chatDeepSeekTool).mockResolvedValue({
        text: "Hello from agent!",
        toolCalls: null,
        reasoningContent: null,
      });

      const agent = request.agent(app);
      await agent.post("/api/chat/agent/credentials").send({ apiKey: "sk-test" });

      const res = await agent
        .post("/api/chat/agent")
        .send({ message: "Hi", model: "test-model" });
      expect(res.status).toBe(200);
      expect(res.body.phase).toBe("done");
      expect(res.body.reply).toBe("Hello from agent!");
    });

    it("returns phase:tool_needed for browser tools", async () => {
      vi.mocked(chatDeepSeekTool).mockResolvedValue({
        text: null,
        toolCalls: [{
          id: "call_0",
          type: "function",
          function: { name: "browser_navigate", arguments: '{"url":"http://localhost:3000"}' },
        }],
        reasoningContent: null,
      });

      const agent = request.agent(app);
      await agent.post("/api/chat/agent/credentials").send({ apiKey: "sk-test" });

      const res = await agent
        .post("/api/chat/agent")
        .send({ message: "Open localhost" });
      expect(res.status).toBe(200);
      expect(res.body.phase).toBe("tool_needed");
      expect(res.body.tool.name).toBe("browser_navigate");
      expect(res.body.sessionId).toBeDefined();
    });
  });

  // ── Agent chat (streaming) ──

  describe("POST /api/chat/agent/stream", () => {
    it("returns 400 when message is missing", async () => {
      const res = await request(app)
        .post("/api/chat/agent/stream")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns SSE events for successful streaming", async () => {
      vi.mocked(chatDeepSeekToolStream).mockReturnValue((async function* () {
        yield { type: "text" as const, text: "Hello" };
        yield { type: "done" as const, finalText: "Hello!", reasoningContent: null, toolCalls: null };
      })());

      const agent = request.agent(app);
      await agent.post("/api/chat/agent/credentials").send({ apiKey: "sk-test" });

      const res = await agent
        .post("/api/chat/agent/stream")
        .send({ message: "Hi", model: "test-model" })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => { cb(null, data); });
        });

      expect(res.status).toBe(200);
      expect(res.body).toContain("data:");
      expect(res.body).toContain("Hello");
    });
  });

  // ── Filesystem API ──

  describe("GET /api/fs/read", () => {
    it("requires a path query parameter", async () => {
      const res = await request(app).get("/api/fs/read");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("EINVAL");
    });
  });

  describe("POST /api/fs/write", () => {
    it("returns 400 when path or content is missing", async () => {
      const res = await request(app)
        .post("/api/fs/write")
        .send({ path: "" });
      expect(res.status).toBe(400);
    });
  });

  // ── System stats ──

  describe("GET /api/system/stats", () => {
    it("returns system statistics", async () => {
      const res = await request(app).get("/api/system/stats");
      expect(res.status).toBe(200);
      expect(res.body.cpu).toBeDefined();
      expect(res.body.cpu.percent).toBeGreaterThanOrEqual(0);
      expect(res.body.memory).toBeDefined();
      expect(res.body.memory.total).toBeGreaterThan(0);
      expect(res.body.platform).toBeDefined();
      expect(res.body.hostname).toBeDefined();
    });
  });

  // ── Session cleanup ──

  describe("DELETE /api/chat/agent/sessions/:threadId", () => {
    it("returns ok even for non-existent session", async () => {
      const res = await request(app).delete("/api/chat/agent/sessions/nonexistent");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("GET /api/chat/agent/config", () => {
    it("returns that no API key is configured", async () => {
      const res = await request(app).get("/api/chat/agent/config");
      expect(res.status).toBe(200);
      expect(res.body.apiKeyConfigured).toBe(false);
      expect(res.body.source).toBe("none");
    });
  });

  describe("session API key storage", () => {
    it("stores a client-entered key in the server session and clears it later", async () => {
      const agent = request.agent(app);

      const initial = await agent.get("/api/chat/agent/config");
      expect(initial.status).toBe(200);
      expect(initial.body.apiKeyConfigured).toBe(false);
      expect(initial.body.source).toBe("none");

      const storeRes = await agent.post("/api/chat/agent/credentials").send({ apiKey: "sk-session" });
      expect(storeRes.status).toBe(200);
      expect(storeRes.body.ok).toBe(true);
      expect(storeRes.body.source).toBe("session");

      const stored = await agent.get("/api/chat/agent/config");
      expect(stored.status).toBe(200);
      expect(stored.body.apiKeyConfigured).toBe(true);
      expect(stored.body.source).toBe("session");

      const cleared = await agent.delete("/api/chat/agent/credentials");
      expect(cleared.status).toBe(200);
      expect(cleared.body.apiKeyConfigured).toBe(false);
      expect(cleared.body.source).toBe("none");
    });
  });

  // ── Project detection ──

  describe("GET /api/project/detect", () => {
    it("returns project info", async () => {
      const res = await request(app).get("/api/project/detect");
      expect(res.status).toBe(200);
      expect(res.body.basePath).toBeDefined();
      expect(typeof res.body.isWin).toBe("boolean");
    });
  });
});
