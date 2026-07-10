import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const BASE_URL = "https://api.deepseek.com/v1";

export interface DeepSeekApiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

function computeCacheContextId(systemContent: string | null | undefined): string | undefined {
  if (!systemContent) return undefined;
  const hash = createHash("sha1").update(systemContent).digest("hex").slice(0, 24);
  return `ctx-${hash}-${systemContent.length}`;
}

// ── Embeddings ──
// Used by the memory system for semantic search. Returns a Float32Array
// or null if the API call fails (caller falls back to keyword search).

export async function generateEmbedding(
  text: string,
  apiKey: string,
): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        input: text,
      }),
    });
    if (!res.ok) {
      // DeepSeek may not support embeddings on all tiers; fail gracefully
      return null;
    }
    const data: any = await res.json();
    const embedding: number[] = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) return null;
    return new Float32Array(embedding);
  } catch {
    return null;
  }
}

// ── Shared fetch helper for DeepSeek API ──
// DeepSeek supports automatic prefix caching: when the system message (first
// element) is identical across requests, the KV cache is reused server-side,
// reducing cost and latency. We track cache context via a hash of the system
// message content, enabling stable prefixes across consecutive turns.

let lastCacheContextId = "";
let cacheHitCount = 0;
let cacheRequestCount = 0;
let cacheMissCount = 0;

function normalizeUsage(raw: any): DeepSeekApiUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? (promptTokens + completionTokens));
  const promptCacheHitTokens = Number(raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? 0);
  const promptCacheMissTokens = Number(raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0);
  if (
    !Number.isFinite(promptTokens)
    && !Number.isFinite(completionTokens)
    && !Number.isFinite(totalTokens)
    && !Number.isFinite(promptCacheHitTokens)
    && !Number.isFinite(promptCacheMissTokens)
  ) {
    return undefined;
  }
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    promptCacheHitTokens: Number.isFinite(promptCacheHitTokens) ? promptCacheHitTokens : 0,
    promptCacheMissTokens: Number.isFinite(promptCacheMissTokens) ? promptCacheMissTokens : 0,
  };
}

function logApiUsage(kind: string, model: string, usage: DeepSeekApiUsage | undefined, cacheContextId?: string) {
  if (!usage) return;
  const cacheTotal = usage.promptCacheHitTokens + usage.promptCacheMissTokens;
  const hitPct = cacheTotal > 0 ? Math.round((usage.promptCacheHitTokens / cacheTotal) * 100) : 0;
  console.log(
    `[cache-api] ${kind} model=${model} prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens}`
    + ` cache_hit_tokens=${usage.promptCacheHitTokens} cache_miss_tokens=${usage.promptCacheMissTokens} hit_rate=${hitPct}%`
    + ` ctx=${(cacheContextId || "").slice(0, 30)}`,
  );
}

async function deepseekFetch(
  apiKey: string,
  body: Record<string, unknown>,
  cacheContextId?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  // Track cache context — when the system message is unchanged, DeepSeek
  // reuses the KV cache for the shared prefix automatically.
  let cacheHit = false;
  if (cacheContextId && cacheContextId === lastCacheContextId) {
    cacheHitCount++;
    cacheHit = true;
  } else if (cacheContextId) {
    cacheMissCount++;
  }
  if (cacheContextId) {
    lastCacheContextId = cacheContextId;
  }
  cacheRequestCount++;
  const model = (body as any).model || "?";
  const stream = (body as any).stream ? "stream" : "block";
  console.log(`[cache] ${stream} #${cacheRequestCount} ${cacheHit ? "HIT" : "MISS"} (hits:${cacheHitCount} misses:${cacheMissCount}) model=${model} ctx=${(cacheContextId || "").slice(0, 30)}`);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers,
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
let lastCleanupDay = 0;

function logOutgoing(label: string, messages: Array<any>, cacheCtx?: string) {
  try {
    const dir = path.resolve(process.cwd(), ".harness-debug");
    fs.mkdirSync(dir, { recursive: true });
    // Cleanup files older than 7 days (run once per day max)
    const now = Date.now();
    const DAY_MS = 86_400_000;
    const MAX_AGE = 7 * DAY_MS;
    if (!lastCleanupDay || now - lastCleanupDay > DAY_MS) {
      lastCleanupDay = now;
      try {
        const files = fs.readdirSync(dir);
        let deleted = 0;
        for (const f of files) {
          const fp = path.join(dir, f);
          try {
            if (fs.statSync(fp).mtimeMs < now - MAX_AGE) { fs.unlinkSync(fp); deleted++; }
          } catch {}
        }
        if (deleted > 0) console.log(`[debug] Cleaned up ${deleted} debug files older than 7 days.`);
      } catch {}
    }
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
    const meta: any = { role: "_meta", assistantWithTools: ac.length, missingReasoning: missing.length };
    if (cacheCtx) {
      meta.cacheContextId = cacheCtx;
      meta.cacheRequests = cacheRequestCount;
      meta.cacheHits = cacheHitCount;
    }
    compact.push(meta);
    fs.writeFileSync(file, JSON.stringify(compact, null, 2), "utf-8");
  } catch (err) {
    console.error("[harness-debug] Failed to write debug log:", err instanceof Error ? err.message : String(err));
  }
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
  /** Actual DeepSeek API usage for this request, including cache token metrics when available. */
  usage?: DeepSeekApiUsage;
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
  const sysMsg = messages.find((m) => m.role === "system");
  const cacheCtx = computeCacheContextId(sysMsg?.content);
  logOutgoing("tool", messages as any[], cacheCtx);

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
  }, cacheCtx);

  const data: any = await res.json();
  const choice = data.choices?.[0]?.message;
  const usage = normalizeUsage(data.usage);
  logApiUsage("block", String(opts?.model || "deepseek-chat"), usage, cacheCtx);
  return {
    text: choice?.content || null,
    reasoningContent: choice?.reasoning_content || null,
    usage,
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
  /** Actual DeepSeek API usage for this request, including cache token metrics when available. */
  usage?: DeepSeekApiUsage;
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
  // Compute cache context ID from the system message (prefix for DeepSeek's KV cache)
  const sysMsg = messages.find((m) => m.role === "system");
  const cacheCtx = computeCacheContextId(sysMsg?.content);
  logOutgoing("stream", messages as any[], cacheCtx);

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
    stream_options: { include_usage: true },
  }, cacheCtx);

  let fullText = "";
  let fullReasoning = "";
  let hasReasoning = false;
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
  let finalUsage: DeepSeekApiUsage | undefined;

  for await (const chunk of parseSSE(res)) {
    const usage = normalizeUsage(chunk.usage);
    if (usage) {
      finalUsage = usage;
    }
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
    usage: finalUsage,
    toolCalls: finalToolCalls,
  };
  logApiUsage("stream", String(opts.model || "deepseek-chat"), finalUsage, cacheCtx);
}
