import fs from "fs";
import path from "path";

const BASE_URL = "https://api.deepseek.com/v1";

// ── Shared fetch helper for DeepSeek API ──
async function deepseekFetch(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

// ── Debug: log outgoing messages to file ──
let logSeq = 0;
function logOutgoing(label: string, messages: Array<any>) {
  try {
    const dir = path.resolve(process.cwd(), ".harness-debug");
    fs.mkdirSync(dir, { recursive: true });
    const seq = String(++logSeq).padStart(3, "0");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `${ts}_${seq}_${label}.json`);
    // Only include role, content, tool_calls, reasoning_content — strip noise
    const compact = messages.map((m: any) => {
      const out: any = { role: m.role };
      if (m.content != null) out.content = typeof m.content === "string" ? m.content.slice(0, 200) : m.content;
      if (m.tool_calls) out.tool_calls = m.tool_calls.map((tc: any) => ({ id: tc.id, fn: tc.function?.name, args: tc.function?.arguments?.slice(0, 200) }));
      if (m.reasoning_content != null) out.reasoning_content = m.reasoning_content.slice(0, 200);
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      return out;
    });
    // Also count which assistant messages have/miss reasoning_content
    const ac = compact.filter((m: any) => m.role === "assistant" && m.tool_calls);
    const missing = ac.filter((m: any) => m.reasoning_content == null);
    compact.push({ role: "_meta", assistantWithTools: ac.length, missingReasoning: missing.length });
    fs.writeFileSync(file, JSON.stringify(compact, null, 2), "utf-8");
  } catch { /* ignore logging errors */ }
}

export async function chatDeepSeek(
  userMessage: string,
  context: string,
  history: { role: "user" | "assistant"; content: string }[],
  apiKey: string,
): Promise<string> {
  const res = await deepseekFetch(apiKey, {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You are an expert software developer assistant inside a web IDE. You help users write, edit, and fix code.

When asked to create or modify code, respond with the exact code inside markdown code blocks using this format:

\`\`\`file:path/to/file.ext
code content here
\`\`\`

The file path is relative to the project root. When modifying code, include the full updated file content.
When explaining code, be concise.
When the user asks a question, answer directly.

Current project files:
${context}`,
      },
      ...history,
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 8192,
  });
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Tool-calling variant (for the agent) ──
// Returns either a text reply or a set of tool calls, depending on what
// DeepSeek decides. Follows the OpenAI function-calling shape.

export interface ToolCallResult {
  text: string | null;
  /** Accumulated reasoning_content from the assistant. DeepSeek requires this passed back. */
  reasoningContent: string | null;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> | null;
}

export async function chatDeepSeekTool(
  messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  opts?: { model?: string; apiKey: string },
): Promise<ToolCallResult> {
  logOutgoing("tool", messages as any[]);

  const res = await deepseekFetch(opts?.apiKey || "", {
    model: opts?.model || "deepseek-chat",
    messages: messages,
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 8192,
  });

  const data: any = await res.json();
  const choice = data.choices?.[0]?.message;
  return {
    text: choice?.content || null,
    reasoningContent: choice?.reasoning_content || null,
    toolCalls: choice?.tool_calls || null,
  };
}

// ── Streaming tool-calling variant ──
// Yields chunks as they arrive: {type: "thinking", text}, {type: "text", text},
// {type: "tool_delta", index, name?, args}, {type: "done", text, toolCalls?}.

export interface StreamChunk {
  type: "thinking" | "text" | "tool_delta" | "done";
  text?: string;
  /** Final accumulated text content (on done). */
  finalText?: string | null;
  /** Final accumulated reasoning_content (on done). DeepSeek requires this passed back. */
  reasoningContent?: string | null;
  /** Final tool calls (on done). */
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> | null;
  /** Index of the tool call being streamed (on tool_delta). */
  toolIndex?: number;
  /** Name of the function (may arrive in later chunks). */
  toolName?: string;
}

/**
 * Parse an SSE (Server-Sent Events) stream from a fetch Response body.
 * Yields each parsed JSON data chunk. Skips [DONE] markers and empty lines.
 */
async function* parseSSE(response: Response): AsyncGenerator<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done && !buffer) break;

      if (value) buffer += decoder.decode(value, { stream: !done });

      // Split on double newlines (SSE frame boundary)
      const parts = buffer.split("\n\n");
      // Keep the last (potentially incomplete) part in the buffer
      buffer = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            // Skip unparseable lines (e.g. comments)
          }
        }
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* chatDeepSeekToolStream(
  messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  opts: { model?: string; apiKey: string },
): AsyncGenerator<StreamChunk> {
  logOutgoing("stream", messages as any[]);

  const res = await deepseekFetch(opts.apiKey, {
    model: opts.model || "deepseek-chat",
    messages,
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 8192,
    stream: true,
  });

  let fullText = "";
  let fullReasoning = "";
  let hasReasoning = false;
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

  for await (const chunk of parseSSE(res)) {
    const delta: any = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    // Reasoning / thinking content (DeepSeek-R1 style)
    // Use != null to preserve empty strings — DeepSeek requires the field back even if empty.
    if (delta.reasoning_content != null) {
      hasReasoning = true;
      fullReasoning += String(delta.reasoning_content);
      yield { type: "thinking", text: delta.reasoning_content };
    }

    // Text content
    if (delta.content) {
      fullText += delta.content;
      yield { type: "text", text: delta.content };
    }

    // Tool call deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx: number = tc.index ?? 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id || "", name: tc.function?.name || "", args: "" };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        yield { type: "tool_delta", toolIndex: idx, toolName: entry.name || undefined, text: tc.function?.arguments || "" };
      }
    }
  }

  // Emit final done with accumulated data
  const finalToolCalls = toolCalls.size > 0
    ? Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      }))
    : null;

  yield {
    type: "done",
    finalText: fullText || null,
    // Only set reasoningContent if the model actually returned reasoning chunks
    reasoningContent: hasReasoning && fullReasoning ? fullReasoning : null,
    toolCalls: finalToolCalls,
  };
}
