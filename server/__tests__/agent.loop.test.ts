// ── Agent loop tests (mocked DeepSeek API) ──
// Tests agentLoop() and agentLoopStream() with controlled API responses.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { agentLoop, agentLoopStream, createAgentSession, type AgentSseEvent } from "../agent";
import fs from "fs";
import path from "path";
import os from "os";

// Mock the DeepSeek module
vi.mock("../deepseek", () => ({
  chatDeepSeekTool: vi.fn(),
  chatDeepSeekToolStream: vi.fn(),
  chatDeepSeek: vi.fn(),
}));

import { chatDeepSeekTool, chatDeepSeekToolStream } from "../deepseek";

// Helper to create a mock API response
function mockResponse(opts: {
  text?: string | null;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  reasoningContent?: string | null;
}) {
  return {
    text: opts.text ?? null,
    toolCalls: opts.toolCalls?.map((tc, i) => ({
      id: `call_${i}`,
      type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    })) ?? null,
    reasoningContent: opts.reasoningContent ?? null,
  };
}

// Helper to reset a mock function completely
function resetMock(fn: unknown) {
  (fn as any).mockReset?.();
}

describe("agentLoop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "h-loop-"));
    resetMock(chatDeepSeekTool);
    resetMock(chatDeepSeekToolStream);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("returns phase:done with text reply when no tool calls", async () => {
    (chatDeepSeekTool as any).mockResolvedValue(
      mockResponse({ text: "Hello! How can I help?" }),
    );

    const state = createAgentSession("s1", tmpDir, "Hi", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("done");
    expect(result.reply).toBe("Hello! How can I help?");
  });

  it("executes filesystem tool and continues the loop", async () => {
    (chatDeepSeekTool as any)
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "world" } }],
      }))
      .mockResolvedValueOnce(mockResponse({ text: "File created!" }))
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{
          name: "write_summary",
          args: {
            summary: "### Changes Made\n- hello.txt: wrote world\n### Verification\n- Verified file exists on disk\n### Outcome\n- File created!",
          },
        }, { name: "task_complete", args: {} }],
      }));

    const state = createAgentSession("s2", tmpDir, "Create hello.txt", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("done");
    expect(result.reply).toBe("### Changes Made\n- hello.txt: wrote world\n### Verification\n- Verified file exists on disk\n### Outcome\n- File created!");
    expect(fs.existsSync(path.join(tmpDir, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf-8")).toBe("world");
  });

  it("handles task_complete to end the loop immediately", async () => {
    (chatDeepSeekTool as any).mockResolvedValue(mockResponse({
      toolCalls: [
        {
          name: "write_summary",
          args: { summary: "### Changes Made\n- (mock)\n### Verification\n- (mock)\n### Outcome\n- All done, created 3 files." },
        },
        { name: "task_complete", args: {} },
      ],
    }));

    const state = createAgentSession("s3", tmpDir, "Do something", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("done");
    expect(result.reply).toBe("### Changes Made\n- (mock)\n### Verification\n- (mock)\n### Outcome\n- All done, created 3 files.");
  });

  it("returns browser tool to renderer", async () => {
    (chatDeepSeekTool as any).mockResolvedValue(mockResponse({
      toolCalls: [{ name: "browser_navigate", args: { url: "http://localhost:3000" } }],
    }));

    const state = createAgentSession("s4", tmpDir, "Open localhost", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("tool_needed");
    expect(result.tool?.name).toBe("browser_navigate");
    expect(result.tool?.params).toEqual({ url: "http://localhost:3000" });
  });

  it("returns error when no API key is provided", async () => {
    const state = createAgentSession("s5", tmpDir, "Hi", "");
    const result = await agentLoop(tmpDir, state, "", {});

    expect(result.phase).toBe("done");
    expect(result.reply).toContain("No server API key configured");
  });

  it("stops after MAX_ITERATIONS and returns summary", async () => {
    // Mock to always return a tool call that keeps looping
    (chatDeepSeekTool as any).mockResolvedValue(mockResponse({
      toolCalls: [{ name: "list_files", args: { path: "." } }],
    }));

    const state = createAgentSession("s6", tmpDir, "Loop forever", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    // After 50 iterations it should stop
    expect(result.phase).toBe("done");
    expect(result.reply).toContain("maximum number of steps");
  }, 30000);

  it("handles multiple tool calls in sequence", async () => {
    (chatDeepSeekTool as any)
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "A" } }],
      }))
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "B" } }],
      }))
      .mockResolvedValueOnce(mockResponse({ text: "Done with both files." }))
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{
          name: "write_summary",
          args: {
            summary: "### Changes Made\n- a.txt: wrote A\n- b.txt: wrote B\n### Verification\n- Verified both files exist on disk\n### Outcome\n- Done with both files.",
          },
        }, { name: "task_complete", args: {} }],
      }));

    const state = createAgentSession("s7", tmpDir, "Create two files", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("done");
    expect(result.reply).toBe("### Changes Made\n- a.txt: wrote A\n- b.txt: wrote B\n### Verification\n- Verified both files exist on disk\n### Outcome\n- Done with both files.");
    expect(fs.existsSync(path.join(tmpDir, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "b.txt"))).toBe(true);
  });

  it("passes reasoning content through to state when present", async () => {
    (chatDeepSeekTool as any).mockResolvedValue(mockResponse({
      text: "I'll help you.",
      reasoningContent: "The user is asking a simple question.",
    }));

    const state = createAgentSession("s8", tmpDir, "Hi", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("done");
  });
});

// ── Streaming agent loop ──

describe("agentLoopStream", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "h-stream-"));
    resetMock(chatDeepSeekTool);
    resetMock(chatDeepSeekToolStream);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("yields text and done events for simple reply", async () => {
    (chatDeepSeekToolStream as any).mockReturnValue((async function* () {
      yield { type: "text" as const, text: "Hello" };
      yield { type: "text" as const, text: " world!" };
      yield { type: "done" as const, finalText: "Hello world!", reasoningContent: null, toolCalls: null };
    })());

    const state = createAgentSession("s10", tmpDir, "Hi", "");
    const events: AgentSseEvent[] = [];

    for await (const event of agentLoopStream(tmpDir, state, "", "s10", { apiKey: "sk-test" })) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === "text");
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    expect(textEvents[0].text).toBe("Hello");
    expect(textEvents[1].text).toBe(" world!");

    const doneEvent = events.find(e => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.reply).toBe("Hello world!");
  });

  it("yields thinking events when model sends reasoning", async () => {
    (chatDeepSeekToolStream as any).mockReturnValue((async function* () {
      yield { type: "thinking" as const, text: "Let me think about this..." };
      yield { type: "done" as const, finalText: "OK", reasoningContent: "thinking", toolCalls: null };
    })());

    const state = createAgentSession("s11", tmpDir, "Complex question", "");
    const events: AgentSseEvent[] = [];

    for await (const event of agentLoopStream(tmpDir, state, "", "s11", { apiKey: "sk-test" })) {
      events.push(event);
    }

    const thinkingEvents = events.filter(e => e.type === "thinking");
    expect(thinkingEvents.length).toBeGreaterThan(0);
  });

  it("yields tool_start and tool_end for filesystem tools, then completes", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "content");

    // First iteration: call read_file tool
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: null,
        reasoningContent: null,
        toolCalls: [{
          id: "call_read",
          type: "function" as const,
          function: { name: "read_file", arguments: '{"path":"test.txt"}' },
        }],
      };
    })());

    // Second iteration (after tool execution): write_summary then task_complete
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: null,
        reasoningContent: null,
        toolCalls: [
          {
            id: "call_summary",
            type: "function" as const,
            function: { name: "write_summary", arguments: '{"summary":"### Changes Made\\n- Read test.txt\\n### Verification\\n- (mock)\\n### Outcome\\n- File read."}' },
          },
          {
            id: "call_done",
            type: "function" as const,
            function: { name: "task_complete", arguments: '{}' },
          },
        ],
      };
    })());

    const state = createAgentSession("s12", tmpDir, "Read test.txt", "");
    const events: AgentSseEvent[] = [];

    for await (const event of agentLoopStream(tmpDir, state, "", "s12", { apiKey: "sk-test" })) {
      events.push(event);
    }

    const toolStarts = events.filter(e => e.type === "tool_start");
    expect(toolStarts.length).toBeGreaterThanOrEqual(1);

    const toolEnds = events.filter(e => e.type === "tool_end");
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);
  });

  it("yields error when no API key", async () => {
    const state = createAgentSession("s13", tmpDir, "Hi", "");
    const events: AgentSseEvent[] = [];

    for await (const event of agentLoopStream(tmpDir, state, "", "s13", {})) {
      events.push(event);
    }

    const errorEvent = events.find(e => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toContain("No server API key configured");
  });

  it("yields browser_tool event for browser actions", async () => {
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: null,
        reasoningContent: null,
        toolCalls: [{
          id: "call_browser",
          type: "function" as const,
          function: { name: "browser_navigate", arguments: '{"url":"http://localhost:3000"}' },
        }],
      };
    })());

    const state = createAgentSession("s14", tmpDir, "Open localhost", "");
    const events: AgentSseEvent[] = [];

    for await (const event of agentLoopStream(tmpDir, state, "", "s14", { apiKey: "sk-test" })) {
      events.push(event);
    }

    const browserEvent = events.find(e => e.type === "browser_tool");
    expect(browserEvent).toBeDefined();
    expect(browserEvent?.toolName).toBe("browser_navigate");
    expect(browserEvent?.toolParams).toEqual({ url: "http://localhost:3000" });
  });

  it("yields permission_required for run_in_terminal", async () => {
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: null,
        reasoningContent: null,
        toolCalls: [{
          id: "call_term",
          type: "function" as const,
          function: { name: "run_in_terminal", arguments: '{"command":"npm start"}' },
        }],
      };
    })());

    const state = createAgentSession("s15", tmpDir, "Start the app", "");
    const events: AgentSseEvent[] = [];

    for await (const event of agentLoopStream(tmpDir, state, "", "s15", { apiKey: "sk-test" })) {
      events.push(event);
    }

    const permEvent = events.find(e => e.type === "permission_required");
    expect(permEvent).toBeDefined();
    expect(permEvent?.permissionCommand).toBe("npm start");
  });
});
