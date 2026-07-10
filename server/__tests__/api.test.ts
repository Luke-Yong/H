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
        .send({ apiKey: "sk-test" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing message");
    });

    it("returns phase:done with text reply", async () => {
      vi.mocked(chatDeepSeekTool).mockResolvedValue({
        text: "Hello from agent!",
        toolCalls: null,
        reasoningContent: null,
      });

      const res = await request(app)
        .post("/api/chat/agent")
        .send({ message: "Hi", apiKey: "sk-test" });
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

      const res = await request(app)
        .post("/api/chat/agent")
        .send({ message: "Open localhost", apiKey: "sk-test" });
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
        .send({ apiKey: "sk-test" });
      expect(res.status).toBe(400);
    });

    it("returns SSE events for successful streaming", async () => {
      vi.mocked(chatDeepSeekToolStream).mockReturnValue((async function* () {
        yield { type: "text" as const, text: "Hello" };
        yield { type: "done" as const, finalText: "Hello!", reasoningContent: null, toolCalls: null };
      })());

      const res = await request(app)
        .post("/api/chat/agent/stream")
        .send({ message: "Hi", apiKey: "sk-test" })
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
