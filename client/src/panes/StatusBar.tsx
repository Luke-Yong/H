import { useState, useRef, useEffect, useCallback } from "react";

const LANGUAGES = [
  "javascript", "typescript", "html", "css", "json", "python",
  "markdown", "xml", "yaml", "sql", "shell", "plaintext",
];

const INDENT_OPTIONS = [
  { label: "Spaces: 2", tabSize: 2, insertSpaces: true },
  { label: "Spaces: 4", tabSize: 4, insertSpaces: true },
  { label: "Tab: 4", tabSize: 4, insertSpaces: false },
  { label: "Tab: 2", tabSize: 2, insertSpaces: false },
];

const ENCODINGS = ["UTF-8", "UTF-16 LE", "UTF-16 BE", "ISO 8859-1"];

/** Map server-detected encoding to display label */
function encodingLabel(serverEnc: string): string {
  const m: Record<string, string> = {
    "utf8": "UTF-8", "utf8bom": "UTF-8 with BOM",
    "utf16le": "UTF-16 LE", "utf16be": "UTF-16 BE",
    "latin1": "ISO 8859-1",
  };
  return m[serverEnc] || serverEnc || "UTF-8";
}

/** Map display label back to server encoding param */
function encodingToServer(label: string): string {
  const m: Record<string, string> = {
    "UTF-8": "utf8", "UTF-8 with BOM": "utf8bom",
    "UTF-16 LE": "utf16le", "UTF-16 BE": "utf16be",
    "ISO 8859-1": "latin1",
  };
  return m[label] || "utf8";
}

const LINE_ENDINGS = [
  { label: "LF", value: "\n" },
  { label: "CRLF", value: "\r\n" },
];

interface Props {
  cursorLine: number;
  cursorColumn: number;
  language: string;
  encoding: string;
  fsBasePath: string;
  hasFsRoot: boolean;
  hasEditor: boolean;
  lspError?: string;
  onSelectLanguage: (lang: string) => void;
  onGoToLine?: (line: number) => void;
  onGoToBracket?: () => void;
  onIndentChange?: (opts: { tabSize: number; insertSpaces: boolean }) => void;
  onLineEndingChange?: (le: string) => void;
  onEncodingChange?: (enc: string) => void;
}

function DropMenu({ open, items, onPick, onClose }: {
  open: boolean;
  items: { label: string; value?: unknown }[];
  onPick: (item: { label: string; value?: unknown }) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="status-dropdown" ref={ref}>
      {items.map((it) => (
        <button key={it.label} className="status-dropdown-item" onClick={() => onPick(it)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function ResourceMonitor() {
  const [cpuPercent, setCpuPercent] = useState(0);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/system/cpu");
        const data = await res.json();
        if (active) setCpuPercent(data.cpuPercent ?? 0);
      } catch { /* */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { active = false; clearInterval(iv); };
  }, []);

  const open = () => {
    const desktop = (window as any).harnessDesktop;
    if (desktop?.openResourceMonitor) {
      desktop.openResourceMonitor();
    }
  };

  return (
    <div className="status-item status-resources" style={{ padding: 0 }}>
      <button className="status-btn" onClick={open} title="System Resources (opens in separate window)">
        📊 {cpuPercent}%
      </button>
    </div>
  );
}

export default function StatusBar({
  cursorLine, cursorColumn, language, encoding, fsBasePath, hasFsRoot, hasEditor, lspError,
  onSelectLanguage, onGoToLine, onGoToBracket, onIndentChange, onLineEndingChange, onEncodingChange,
}: Props) {
  const [langOpen, setLangOpen] = useState(false);
  const [indentIdx, setIndentIdx] = useState(0);
  const [lineEndIdx, setLineEndIdx] = useState(0);
  const [indentOpen, setIndentOpen] = useState(false);
  const [encOpen, setEncOpen] = useState(false);
  const [leOpen, setLeOpen] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  const gotoRef = useRef<HTMLInputElement>(null);
  const gotoPopupRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
      if (gotoPopupRef.current && !gotoPopupRef.current.contains(e.target as Node)) {
        setGotoOpen(false);
      }
    };
    if (langOpen || gotoOpen) document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [langOpen, gotoOpen]);

  useEffect(() => {
    if (gotoOpen) {
      setTimeout(() => gotoRef.current?.focus(), 0);
    }
  }, [gotoOpen]);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <ResourceMonitor />
        {hasFsRoot && (
          <span className="status-item" title="Source Control: main">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4 }}>
              <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
              <circle cx="11" cy="11" r="1.5" fill="currentColor"/>
              <circle cx="11" cy="5" r="1.5" fill="currentColor"/>
              <path d="M5 6.5V9.5M6.5 8H9.5" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            main
          </span>
        )}
        {lspError && (
          <span className="status-item" title={lspError} style={{ color: "#e2b714", cursor: "help" }}>
            ⚠ LSP: {lspError.length > 40 ? lspError.slice(0, 40) + "..." : lspError}
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {hasEditor && (
          <div className="status-item status-popup-host">
            <span className="status-item" title="Go to Line" onClick={() => { setGotoOpen((v) => !v); setGotoVal(""); }} style={{ padding: 0, cursor: "pointer" }}>
              Ln {cursorLine}, Col {cursorColumn}
            </span>
            {gotoOpen && (
              <div ref={gotoPopupRef} className="status-goto-popup">
                <div className="status-goto-label">Go to Line (1–99999)</div>
                <input
                  ref={gotoRef}
                  className="status-goto-input"
                  type="number"
                  min={1}
                  value={gotoVal}
                  placeholder="Line number"
                  onChange={(e) => setGotoVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      const ln = parseInt(gotoVal, 10);
                      if (!isNaN(ln) && ln > 0) onGoToLine?.(ln);
                      setGotoOpen(false);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setGotoOpen(false);
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}
        {hasEditor && (
          <div className="status-item status-popup-host">
            <button className="status-btn" onClick={() => setIndentOpen((v) => !v)} title="Select Indentation">
              {INDENT_OPTIONS[indentIdx].label}
            </button>
            <DropMenu
              open={indentOpen}
              items={INDENT_OPTIONS}
              onPick={(item) => {
                const idx = INDENT_OPTIONS.findIndex((o) => o.label === item.label);
                setIndentIdx(idx >= 0 ? idx : 0);
                setIndentOpen(false);
                onIndentChange?.(item.value as { tabSize: number; insertSpaces: boolean });
              }}
              onClose={() => setIndentOpen(false)}
            />
          </div>
        )}
        {hasEditor && (
          <div className="status-item status-popup-host">
            <button className="status-btn" onClick={() => setEncOpen((v) => !v)} title="Select Encoding">
              {encodingLabel(encoding)}
            </button>
            <DropMenu
              open={encOpen}
              items={ENCODINGS.map((e) => ({ label: e }))}
              onPick={(item) => {
                setEncOpen(false);
                onEncodingChange?.(encodingToServer(item.label));
              }}
              onClose={() => setEncOpen(false)}
            />
          </div>
        )}
        {hasEditor && (
          <div className="status-item status-popup-host">
            <button className="status-btn" onClick={() => setLeOpen((v) => !v)} title="Select End of Line Sequence">
              {LINE_ENDINGS[lineEndIdx].label}
            </button>
            <DropMenu
              open={leOpen}
              items={LINE_ENDINGS}
              onPick={(item) => {
                const idx = LINE_ENDINGS.findIndex((o) => o.label === item.label);
                setLineEndIdx(idx >= 0 ? idx : 0);
                setLeOpen(false);
                onLineEndingChange?.(item.label);
              }}
              onClose={() => setLeOpen(false)}
            />
          </div>
        )}
        {hasEditor && (
        <div className="status-item status-popup-host" ref={langRef} title="Select Language Mode">
          <button className="status-btn" onClick={() => setLangOpen((v) => !v)}>
            {language}
          </button>
          {langOpen && (
            <div className="status-lang-menu">
              {LANGUAGES.map((l) => (
                <button
                  key={l}
                  className={`status-lang-item${language === l ? " active" : ""}`}
                  onClick={() => { onSelectLanguage(l); setLangOpen(false); }}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        {hasEditor && (
          <span className="status-item" title="Go to Bracket" onClick={() => {
            if (onGoToBracket) onGoToBracket();
          }}>
            {"{}"}
          </span>
        )}
      </div>
    </div>
  );
}
