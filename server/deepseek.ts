import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || "sk-your-key-here",
  baseURL: "https://api.deepseek.com/v1",
});

interface AIAction {
  action: "click" | "type";
  index: number;
  text?: string;
}

interface AIResponse {
  reasoning: string;
  actions: AIAction[];
  conclusion: "pass" | "fail" | "continue";
  message: string;
}

export async function chatDeepSeek(
  userMessage: string,
  context: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const response = await client.chat.completions.create({
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
    max_tokens: 4000,
  });
  return response.choices[0]?.message?.content || "";
}

export async function askDeepSeek(
  domStructure: string,
  userGoal: string,
  previousActions: string[]
): Promise<AIResponse> {
  const systemPrompt = `You are a test automation agent. Given a DOM structure with indexed elements and a user's test goal, determine what actions to take.

DOM elements are formatted as: [index] <tag attributes> "visible text"

Available actions:
- {"action":"click","index":N}  — click element at index N
- {"action":"type","index":N,"text":"value"} — type text into element at index N

Rules:
1. Return actions in the order they should be executed.
2. If the goal is achieved, set conclusion to "pass" with a success message.
3. If more actions are needed, set conclusion to "continue".
4. If the goal cannot be achieved, set conclusion to "fail" with an explanation.
5. Only interact with visible, actionable elements (buttons, inputs, links, selects).
6. Each response can have at most 3 actions.

Respond ONLY with valid JSON in this exact format:
{
  "reasoning": "why you chose these actions",
  "actions": [{"action":"click","index":0},{"action":"type","index":1,"text":"hello"}],
  "conclusion": "continue",
  "message": "description of what was done or why pass/fail"
}`;

  const previousContext = previousActions.length
    ? `\nPrevious actions taken:\n${previousActions.join("\n")}`
    : "";

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Goal: ${userGoal}\n\nCurrent DOM:\n${domStructure}${previousContext}\n\nWhat should I do next?`,
      },
    ],
    temperature: 0.1,
    max_tokens: 2000,
  });

  const content = response.choices[0]?.message?.content || "{}";
  // Extract JSON from the response (handle markdown code blocks)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`DeepSeek did not return valid JSON:\n${content}`);

  return JSON.parse(jsonMatch[0]) as AIResponse;
}

// ── Tool-calling variant (for the agent) ──
// Returns either a text reply or a set of tool calls, depending on what
// DeepSeek decides. Follows the OpenAI function-calling shape.

export interface ToolCallResult {
  text: string | null;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> | null;
}

export async function chatDeepSeekTool(
  messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): Promise<ToolCallResult> {
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: messages as any,
    // @ts-ignore DeepSeek supports tools in OpenAI shape
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 4000,
  });

  const choice = response.choices[0]?.message;
  return {
    text: choice?.content || null,
    toolCalls: choice?.tool_calls as any || null,
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

export async function* chatDeepSeekToolStream(
  messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): AsyncGenerator<StreamChunk> {
  const stream = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: messages as any,
    // @ts-ignore
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 4000,
    stream: true,
  });

  let fullText = "";
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

  for await (const chunk of stream) {
    const delta = (chunk as any).choices?.[0]?.delta;
    if (!delta) continue;

    // Reasoning / thinking content (DeepSeek-R1 style)
    if (delta.reasoning_content) {
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
        const idx = tc.index ?? 0;
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
    toolCalls: finalToolCalls,
  };
}
