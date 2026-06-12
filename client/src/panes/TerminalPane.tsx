import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const WS_URL =
  window.location.port === "5173"
    ? "ws://localhost:3001/ws"
    : `ws://${window.location.host}/ws`;

function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("/")) return true;
  return false;
}

interface TermInstance {
  id: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  backend: "pty" | "pipe";
  input: string;
  history: string[];
  historyIndex: number;
  historyKey: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  cwd?: string;
  venvDir?: string;
  activateScript?: string;
}

export default function TerminalPane({ visible, onClose, cwd, venvDir, activateScript }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termsRef = useRef<Map<string, TermInstance>>(new Map());
  const groupKeyRef = useRef("");
  const [termIds, setTermIds] = useState<string[]>([]);
  const [backendById, setBackendById] = useState<Record<string, "pty" | "pipe">>({});
  const [activeId, setActiveId] = useState<string>("");
  const activeIdRef = useRef(activeId);
  const [splitMode, setSplitMode] = useState(false);
  const cwdRef = useRef<string>("");
  const venvRef = useRef<string>("");
  const activateRef = useRef<string>("");
  const hasRealCwdRef = useRef<boolean>(false);

  // Keep ref in sync for the WS effect (which must NOT re-run on activeId changes)
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => {
    const c = (cwd || "").trim();
    cwdRef.current = c;
    hasRealCwdRef.current = isAbsolutePath(c);
  }, [cwd]);
  useEffect(() => { venvRef.current = (venvDir || "").trim(); }, [venvDir]);
  useEffect(() => { activateRef.current = (activateScript || "").trim(); }, [activateScript]);

  const sendToServer = useCallback((id: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(`term:write:${id}:${data}`);
    }
  }, []);

  const getHistoryKey = useCallback(() => {
    const c = (cwdRef.current || "").trim();
    return `harness.term.history:${c || "default"}`;
  }, []);

  const loadHistory = useCallback((key: string): string[] => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
      return [];
    } catch {
      return [];
    }
  }, []);

  const saveHistory = useCallback((key: string, items: string[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(items.slice(-200)));
    } catch {}
  }, []);

  const setInputLine = useCallback((inst: TermInstance, next: string) => {
    const prev = inst.input;
    if (prev.length) {
      inst.term.write("\b \b".repeat(prev.length));
    }
    inst.input = next;
    if (next.length) inst.term.write(next);
  }, []);

  const runLine = useCallback((inst: TermInstance) => {
    const line = inst.input;
    inst.term.write("\r\n");
    if (line.trim().length) {
      if (inst.history[inst.history.length - 1] !== line) inst.history.push(line);
      saveHistory(inst.historyKey, inst.history);
    }
    inst.historyIndex = inst.history.length;
    inst.input = "";
    sendToServer(inst.id, `${line}\r\n`);
  }, [saveHistory, sendToServer]);

  const handlePasteText = useCallback((inst: TermInstance, text: string) => {
    if (inst.backend === "pty") {
      sendToServer(inst.id, text);
      return;
    }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part) {
        inst.input += part;
        inst.term.write(part);
      }
      if (i < parts.length - 1) {
        runLine(inst);
      }
    }
  }, [runLine, sendToServer]);

  const handleInput = useCallback((inst: TermInstance, data: string) => {
    if (inst.backend === "pty") {
      sendToServer(inst.id, data);
      return;
    }
    if (data === "\x1b[A") {
      if (!inst.history.length) return;
      const nextIdx = Math.max(0, inst.historyIndex - 1);
      inst.historyIndex = nextIdx;
      setInputLine(inst, inst.history[nextIdx] || "");
      return;
    }

    if (data === "\x1b[B") {
      if (!inst.history.length) return;
      const nextIdx = Math.min(inst.history.length, inst.historyIndex + 1);
      inst.historyIndex = nextIdx;
      setInputLine(inst, inst.history[nextIdx] || "");
      return;
    }

    if (data.length > 1 && (data.includes("\n") || data.includes("\r"))) {
      handlePasteText(inst, data);
      return;
    }

    if (data === "\r") {
      runLine(inst);
      return;
    }

    if (data === "\x03") {
      inst.term.write("^C\r\n");
      inst.input = "";
      inst.historyIndex = inst.history.length;
      sendToServer(inst.id, "\x03");
      return;
    }

    if (data === "\x7f" || data === "\x08") {
      if (!inst.input.length) return;
      inst.input = inst.input.slice(0, -1);
      inst.term.write("\b \b");
      return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    inst.input += data;
    inst.term.write(data);
  }, [handlePasteText, runLine, sendToServer, setInputLine]);

  const createTerminal = useCallback((id: string, container: HTMLDivElement, backend: "pty" | "pipe") => {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#264f78",
        black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
        blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
        brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
        brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
        brightCyan: "#29b8db", brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      windowsMode: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const inst: TermInstance = {
      id,
      term,
      fit,
      container,
      backend,
      input: "",
      history: [],
      historyIndex: 0,
      historyKey: "",
    };

    inst.historyKey = getHistoryKey();
    if (backend === "pipe") {
      inst.history = loadHistory(inst.historyKey);
      inst.historyIndex = inst.history.length;
    }

    // Show diagnostic header
    const isDesktop = !!(window as any).harnessDesktop?.isDesktop;
    if (hasRealCwdRef.current) {
      term.writeln(`\r\n\x1b[36m[Harness]\x1b[0m cwd=\x1b[33m${cwdRef.current}\x1b[0m  (\x1b[32mElectron\x1b[0m)\r\n`);
    } else {
      term.writeln("\r\n\x1b[36m[Harness]\x1b[0m \x1b[31mNo project folder detected\x1b[0m");
      if (isDesktop) {
        term.writeln("[Harness] You are in Electron but no folder path was provided.");
      } else {
        term.writeln("[Harness] You are in a \x1b[33mbrowser\x1b[0m — the file picker can't give real paths.");
        term.writeln("[Harness] Run \x1b[33mnpm run desktop:dev\x1b[0m for real project-following terminals.\r\n");
      }
    }

    term.attachCustomKeyEventHandler((ev) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const ctrlOrMeta = isMac ? ev.metaKey : ev.ctrlKey;

      if (ev.type === "keydown" && ctrlOrMeta && !ev.shiftKey && ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      }

      if (ev.type === "keydown" && ctrlOrMeta && ev.shiftKey && ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.type === "keydown" && ctrlOrMeta && (ev.code === "KeyV" || (ev.shiftKey && ev.code === "KeyV"))) {
        void navigator.clipboard.readText().then((t) => handlePasteText(inst, t)).catch(() => {});
        return false;
      }
      if (ev.type === "keydown" && ev.shiftKey && ev.code === "Insert") {
        void navigator.clipboard.readText().then((t) => handlePasteText(inst, t)).catch(() => {});
        return false;
      }
      if (ev.type === "keydown" && ctrlOrMeta && ev.code === "Insert") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }

      return true;
    });

    term.onData((data) => handleInput(inst, data));

    term.onResize(({ cols, rows }) => {
      fit.fit();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(`term:resize:${id}:${cols}:${rows}`);
      }
    });

    termsRef.current.set(id, inst);
  }, [getHistoryKey, handleInput, handlePasteText, loadHistory]);

  useEffect(() => {
    if (!visible) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    const groupKey = `term-${Date.now()}`;
    groupKeyRef.current = groupKey;

    ws.onopen = () => {
      const c = hasRealCwdRef.current ? cwdRef.current : "";
      const v = venvRef.current;
      const a = activateRef.current;
      ws.send(`term:create:${groupKey}:${encodeURIComponent(c)}:${encodeURIComponent(v)}:${encodeURIComponent(a)}`);
    };

    ws.onmessage = (msg) => {
      const data = msg.data as string;
      if (data.startsWith("term:ready:")) {
        const rest = data.slice(11);
        const sep = rest.indexOf(":");
        const id = sep === -1 ? rest : rest.slice(0, sep);
        const backend = (sep === -1 ? "pipe" : rest.slice(sep + 1)) === "pty" ? "pty" : "pipe";
        setBackendById((prev) => ({ ...prev, [id]: backend }));
        setTermIds((prev) => {
          const next = [...prev, id];
          if (!activeIdRef.current) setActiveId(id);
          return next;
        });
      } else if (data.startsWith("term:out:")) {
        const rest = data.slice(9);
        const idx = rest.indexOf(":");
        if (idx === -1) return;
        const id = rest.slice(0, idx);
        const output = rest.slice(idx + 1);
        // Clean Windows console output for xterm.js compatibility:
        // - DEL (\x7f) → BS (\x08)
        // - Stray CSI sequences without proper ESC prefix (broken by pipe)
        const clean = output
          .replace(/\x7f/g, "\x08")
          .replace(/(?<!\x1b)\[(?=[0-9?;]*[A-Za-z@])/g, "\x1b[");
        const inst = termsRef.current.get(id);
        inst?.term.write(clean);
      } else if (data.startsWith("term:exit:")) {
        const rest = data.slice(10);
        const idx = rest.indexOf(":");
        if (idx === -1) return;
        const id = rest.slice(0, idx);
        const code = rest.slice(idx + 1);
        const inst = termsRef.current.get(id);
        inst?.term.writeln(`\r\n[Process exited code=${code}]`);
        setTermIds((prev) => {
          const next = prev.filter((x) => x !== id);
          if (activeIdRef.current === id) {
            const currentIdx = prev.indexOf(id);
            // Pick next tab, or previous if we were at the end
            const newActiveIdx = currentIdx < next.length ? currentIdx : Math.max(0, next.length - 1);
            const newActive = next[newActiveIdx] || "";
            setActiveId(newActive);
          }
          return next;
        });
      }
    };

    return () => {
      ws.close();
    };
  }, [visible]); // <-- activeId removed from deps

  // Attach terminals to DOM when termIds change
  useEffect(() => {
    if (!visible) return;
    // Give React time to render containers
    const timer = setTimeout(() => {
      for (const id of termIds) {
        if (termsRef.current.has(id)) continue;
        const el = document.getElementById(`term-${id}`);
        if (el && el.childElementCount === 0) {
          createTerminal(id, el as HTMLDivElement, backendById[id] || "pipe");
        }
      }
      // Remove disposed
      for (const [id] of termsRef.current) {
        if (!termIds.includes(id)) {
          const inst = termsRef.current.get(id);
          inst?.term.dispose();
          termsRef.current.delete(id);
        }
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [termIds, backendById, visible, createTerminal]);

  // Re-fit on panel resize
  useEffect(() => {
    if (!visible) return;
    const handler = () => {
      for (const [, inst] of termsRef.current) {
        try { inst.fit.fit(); } catch {}
      }
    };
    const obs = new ResizeObserver(handler);
    if (panelRef.current) obs.observe(panelRef.current);
    return () => obs.disconnect();
  }, [visible]);

  const addTerminal = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const c = hasRealCwdRef.current ? cwdRef.current : "";
      const v = venvRef.current;
      const a = activateRef.current;
      wsRef.current.send(`term:create:${groupKeyRef.current}:${encodeURIComponent(c)}:${encodeURIComponent(v)}:${encodeURIComponent(a)}`);
    }
  }, []);

  const killTerminal = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(`term:kill:${id}`);
    }
    setTermIds((prev) => {
      const next = prev.filter((x) => x !== id);
      if (activeIdRef.current === id) {
        const currentIdx = prev.indexOf(id);
        const newActiveIdx = currentIdx < next.length ? currentIdx : Math.max(0, next.length - 1);
        setActiveId(next[newActiveIdx] || "");
      }
      return next;
    });
  }, []);

  if (!visible) return null;

  return (
    <div className="terminal-pane">
      <div className="pane-header">
        <div className="terminal-tabs">
          {termIds.map((id, i) => (
            <button
              key={id}
              className={`terminal-tab${id === activeId ? " active" : ""}`}
              onClick={() => setActiveId(id)}
            >
              Term {i + 1}
              <span
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); killTerminal(id); }}
              >✕</span>
            </button>
          ))}
        </div>
        <div className="terminal-actions">
          <button className="files-add-btn" onClick={addTerminal} title="New Terminal">+</button>
          <button
            className="files-add-btn"
            onClick={() => setSplitMode(!splitMode)}
            title="Split Terminal"
            style={{ color: splitMode ? "var(--accent)" : undefined }}
          >
            ▣
          </button>
          <button className="terminal-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="terminal-container" ref={panelRef}>
        <div className={`terminal-grid${splitMode ? " split" : ""}`}>
          {termIds
            .filter((id) => !splitMode || id === activeId || id === termIds[1] || id === termIds[0])
            .map((id) => (
              <div
                key={id}
                id={`term-${id}`}
                className={`terminal-slot${id === activeId ? " active" : ""}`}
                style={{ display: splitMode || id === activeId ? "flex" : "none" }}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
