import { injectCode, extractDOM, clickElement, typeIntoElement, takeScreenshot } from "./browser";
import { askDeepSeek } from "./deepseek";
import { WebSocket } from "ws";

export interface LoopConfig {
  html: string;
  css: string;
  js: string;
  goal: string;
  maxSteps: number;
  apiKey?: string;
}

export interface LoopEvent {
  type: "log" | "action" | "dom" | "screenshot" | "result" | "error" | "assistant" | "code";
  data: unknown;
}

type EventEmitter = (event: LoopEvent) => void;

export async function runLoop(config: LoopConfig, emit: EventEmitter): Promise<void> {
  const { html, css, js, goal, maxSteps, apiKey } = config;
  const actionLog: string[] = [];
  const resolvedApiKey = apiKey || process.env.DEEPSEEK_API_KEY || "";

  try {
    // Step 1: Inject user code into browser
    emit({ type: "log", data: "Injecting code into browser..." });
    await injectCode(html, css, js);
    emit({ type: "log", data: "Code injected. Page rendered." });

    // Send initial screenshot
    const initialShot = await takeScreenshot();
    emit({ type: "screenshot", data: initialShot.toString("base64") });

    for (let step = 0; step < maxSteps; step++) {
      emit({ type: "log", data: `--- Step ${step + 1}/${maxSteps} ---` });

      // Step 2: Extract DOM structure
      const dom = await extractDOM();
      emit({ type: "dom", data: dom });
      emit({ type: "log", data: `Extracted ${dom.split("\n").length} DOM elements` });

      // Step 3: Ask DeepSeek
      emit({ type: "log", data: "Asking DeepSeek for next actions..." });
      const aiResponse = await askDeepSeek(dom, goal, actionLog, resolvedApiKey);
      emit({ type: "log", data: `DeepSeek reasoning: ${aiResponse.reasoning}` });

      // Step 4: Execute actions
      for (const act of aiResponse.actions) {
        const desc = act.action === "click"
          ? `Clicking element [${act.index}]`
          : `Typing "${act.text}" into element [${act.index}]`;
        emit({ type: "action", data: { action: act.action, index: act.index, text: act.text } });
        emit({ type: "log", data: desc });
        actionLog.push(desc);

        if (act.action === "click") {
          await clickElement(act.index);
        } else if (act.action === "type" && act.text) {
          await typeIntoElement(act.index, act.text);
        }
      }

      // Take screenshot after actions
      const shot = await takeScreenshot();
      emit({ type: "screenshot", data: shot.toString("base64") });

      // Step 5: Check result
      if (aiResponse.conclusion === "pass") {
        emit({ type: "result", data: { verdict: "pass", message: aiResponse.message } });
        emit({ type: "log", data: `PASS: ${aiResponse.message}` });
        return;
      } else if (aiResponse.conclusion === "fail") {
        emit({ type: "result", data: { verdict: "fail", message: aiResponse.message } });
        emit({ type: "log", data: `FAIL: ${aiResponse.message}` });
        return;
      }
      // conclusion === "continue" → loop again
    }

    emit({ type: "result", data: { verdict: "fail", message: `Max steps (${maxSteps}) reached without pass/fail conclusion` } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", data: message });
    emit({ type: "result", data: { verdict: "error", message } });
  }
}
