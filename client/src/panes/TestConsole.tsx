import { useRef, useEffect, useState, useCallback } from "react";
import type { LoopEvent } from "../../../server/loop";

interface Props {
  events: LoopEvent[];
  /** Goal input (shown at bottom of Test Runner) */
  goal: string;
  onGoalChange: (value: string) => void;
  onRun: () => void;
  connected: boolean;
}

export default function TestConsole({ events, goal, onGoalChange, onRun, connected }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"test" | "chat">("test");
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, chatHistory]);

  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput("");
    setChatLoading(true);
    setChatHistory((prev) => [...prev, { role: "user", content: msg }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          context: "Use the `file:` code block format when generating/modifying files.",
          history: chatHistory,
        }),
      });
      const data = await res.json();
      if (data.reply) {
        setChatHistory((prev) => [...prev, { role: "assistant", content: data.reply }]);
      }
    } catch (err) {
      setChatHistory((prev) => [...prev, { role: "assistant", content: `Error: ${err}` }]);
    }
    setChatLoading(false);
  }, [chatInput, chatHistory]);

  const renderMarkdown = (text: string) => {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, i) => {
      const m = part.match(/^```(\w+)?\n?([\s\S]*?)```$/);
      if (m) {
        return (
          <pre key={i} className="chat-code-block">
            <code>{m[2]}</code>
          </pre>
        );
      }
      const formatted = part
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
      return <span key={i} dangerouslySetInnerHTML={{ __html: formatted }} />;
    });
  };

  return (
    <div className="console-panel">
      <div className="console-tabs">
        <button
          className={`console-tab${mode === "test" ? " active" : ""}`}
          onClick={() => setMode("test")}
        >
          Test Runner
        </button>
        <button
          className={`console-tab${mode === "chat" ? " active" : ""}`}
          onClick={() => setMode("chat")}
        >
          AI Chat
        </button>
      </div>

      {mode === "test" ? (
        <>
          <div className="console-list">
            {events.length === 0 && (
              <div className="console-entry log" style={{ fontStyle: "italic" }}>
                Waiting for test run...
              </div>
            )}
            {events.map((evt, i) => {
              let cls = "log";
              if (evt.type === "action") cls = "action";
              else if (evt.type === "dom") cls = "dom";
              else if (evt.type === "result") {
                const r = evt.data as { verdict: string; message: string };
                cls = r.verdict;
              } else if (evt.type === "assistant") cls = "assistant";
              else if (evt.type === "error") cls = "error";

              const display =
                evt.type === "action"
                  ? `${(evt.data as { action: string; index: number; text?: string }).action} [${(evt.data as { index: number }).index}]${(evt.data as { text?: string }).text ? ` "${(evt.data as { text: string }).text}"` : ""}`
                  : evt.type === "result"
                    ? `${(evt.data as { verdict: string }).verdict.toUpperCase()}: ${(evt.data as { message: string }).message}`
                    : evt.type === "dom"
                      ? String(evt.data).slice(0, 2000)
                      : evt.type === "assistant"
                        ? `AI: ${String(evt.data).slice(0, 500)}`
                        : String(evt.data);

              return (
                <div key={i} className={`console-entry ${cls}`}>
                  {display}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
          <div className="goal-bar">
            <input
              className="goal-input"
              value={goal}
              onChange={(e) => onGoalChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onRun(); }}
              placeholder="Test goal, e.g. 'Verify login works with valid credentials'"
            />
            <button
              className="run-btn"
              onClick={onRun}
              disabled={!connected}
            >
              {connected ? "Run Test" : "Con..."}
            </button>
          </div>
        </>
      ) : (
        <div className="chat-container">
          <div className="console-list">
            {chatHistory.length === 0 && (
              <div className="console-entry log" style={{ fontStyle: "italic" }}>
                Ask the AI to write or explain code...
              </div>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`chat-message ${msg.role}`}>
                <span className="chat-role">{msg.role === "user" ? "You" : "AI"}</span>
                <div className="chat-content">{renderMarkdown(msg.content)}</div>
              </div>
            ))}
            {chatLoading && (
              <div className="console-entry log" style={{ fontStyle: "italic" }}>
                AI is thinking...
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="chat-input-row">
            <input
              className="chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }}}
              placeholder="Ask AI to write or explain code..."
            />
            <button className="chat-send-btn" onClick={sendChat} disabled={chatLoading || !chatInput.trim()}>
              {chatLoading ? "..." : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
