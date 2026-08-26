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

  it("refuses task_complete while unread cached command output remains", async () => {
    (chatDeepSeekTool as any)
      // 1. Run a command (real echo — output cached as cmd #1)
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{ name: "run_command", args: { command: "echo refuse-me-123" } }],
      }))
      // 2. Agent replies with text only, then tries to finish
      .mockResolvedValueOnce(mockResponse({ text: "The output got cached. Let me read the full output of the test run." }))
      // 3. Agent calls write_summary + task_complete → task_complete MUST be refused (unread cached output)
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [
          { name: "write_summary", args: { summary: "### Changes Made\n- (mock)\n### Verification\n- (mock)\n### Outcome\n- Ran the command and captured its output." } },
          { name: "task_complete", args: {} },
        ],
      }))
      // 4. Agent reads the cached output
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [{ name: "read_command_output", args: { cmd_id: 1 } }],
      }))
      // 5. Agent finishes properly — task_complete now allowed
      .mockResolvedValueOnce(mockResponse({
        toolCalls: [
          { name: "write_summary", args: { summary: "### Changes Made\n- (mock)\n### Verification\n- (mock)\n### Outcome\n- Read the output and completed the task." } },
          { name: "task_complete", args: {} },
        ],
      }));

    const state = createAgentSession("s-refuse", tmpDir, "Run the tests and report the output", "");
    const result = await agentLoop(tmpDir, state, "", { apiKey: "sk-test" });

    expect(result.phase).toBe("done");
    // The premature task_complete attempt (step 3) must have been refused — the
    // turn must have continued until the cached output was read.
    expect(result.reply).toContain("Read the output and completed the task.");
  }, 30000);

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

  it("continues past a text-only reply after a run_in_terminal tool result (does not end the turn)", async () => {
    // Simulate the session state right after /stream/continue pushed the
    // run_in_terminal result (summarized, output cached as cmd #1).
    const state = createAgentSession("s16", tmpDir, "Run the tests", "");
    state.messages.push({
      role: "assistant" as const,
      content: JSON.stringify([{ id: "call_term", type: "function", function: { name: "run_in_terminal", arguments: '{"command":"python test_routes.py"}' } }]),
      name: "run_in_terminal",
    });
    state.messages.push({
      role: "tool" as const,
      content: "Terminal output. Exit code 0. Full output is cached as cmd #1; call read_command_output for more.\nKey lines:\n- test passed",
      tool_call_id: "call_term",
    });

    // 1st model call: agent replies with text only — must NOT end the turn
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: "The test_routes.py ran and printed some output. Let me read the full output to see if tests passed.",
        reasoningContent: null,
        toolCalls: null,
      };
    })());
    // 2nd model call: agent continues and reads the cached output
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: null,
        reasoningContent: null,
        toolCalls: [{ id: "c2", type: "function", function: { name: "read_command_output", arguments: '{"cmd_id":1}' } }],
      };
    })());
    // 3rd model call: agent finishes
    (chatDeepSeekToolStream as any).mockReturnValueOnce((async function* () {
      yield {
        type: "done" as const,
        finalText: null,
        reasoningContent: null,
        toolCalls: [
          { id: "c3a", type: "function", function: { name: "write_summary", arguments: '{"summary":"### Changes Made\\n- (mock)\\n### Verification\\n- (mock)\\n### Outcome\\n- Read the output and completed."}' } },
          { id: "c3b", type: "function", function: { name: "task_complete", arguments: "{}" } },
        ],
      };
    })());

    const events: AgentSseEvent[] = [];
    for await (const event of agentLoopStream(tmpDir, state, "", "s16", { apiKey: "sk-test" })) {
      events.push(event);
      if (event.type === "done") break;
    }

    // The turn must NOT end with the text-only reply as the final message.
    // The loop must have continued to a read_command_output tool card.
    expect(events.find(e => e.type === "done")).toBeDefined(); // eventually completes
    expect(events.some(e => e.type === "tool_start" && e.toolName === "read_command_output")).toBe(true);
  }, 30000);
});
