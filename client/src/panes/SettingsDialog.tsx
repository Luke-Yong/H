import { useState, useCallback, useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabId = "model" | "about";

// ── Model & API Key management ──

function ModelApiTab() {
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [configChecked, setConfigChecked] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("harness-model") || "deepseek-chat");
  const [isThinking, setIsThinking] = useState(() => localStorage.getItem("harness-thinking") === "true");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  const refreshConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/agent/config");
      const data = await res.json();
      setApiKeyConfigured(Boolean(data?.apiKeyConfigured));
    } catch { setApiKeyConfigured(false); }
    finally { setConfigChecked(true); }
  }, []);

  useEffect(() => { refreshConfig(); }, [refreshConfig]);

  const saveApiKey = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) { setStatus("API key cannot be empty."); return; }
    setSaving(true); setStatus("");
    try {
      const res = await fetch("/api/chat/agent/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      setApiKey(""); await refreshConfig();
      setStatus("API key saved successfully.");
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally { setSaving(false); }
  }, [apiKey, refreshConfig]);

  const clearApiKey = useCallback(async () => {
    setSaving(true); setStatus("");
    try {
      const res = await fetch("/api/chat/agent/credentials", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      await refreshConfig();
      setStatus("API key removed.");
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally { setSaving(false); }
  }, [refreshConfig]);

  const handleModelSave = () => {
    localStorage.setItem("harness-model", selectedModel.trim());
    setStatus("Model saved.");
  };

  const handleThinkingToggle = () => {
    const next = !isThinking;
    setIsThinking(next);
    localStorage.setItem("harness-thinking", String(next));
  };

  if (!configChecked) return <div className="settings-tab-loading">Loading configuration...</div>;

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <label className="settings-label">Model</label>
        <div className="settings-model-row">
          <input className="settings-input" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} placeholder="e.g. deepseek-chat" />
          <button className="settings-btn settings-btn-small" onClick={handleModelSave}>Save</button>
        </div>
        <p className="settings-hint">Model identifier used for agent requests.</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Thinking Mode</label>
        <label className="settings-toggle">
          <input type="checkbox" checked={isThinking} onChange={handleThinkingToggle} />
          <span className="settings-toggle-label">Enable reasoning/thinking output</span>
        </label>
      </div>

      <div className="settings-section">
        <label className="settings-label">DeepSeek API Key</label>
        {apiKeyConfigured ? (
          <div className="settings-key-status">
            <span className="settings-key-indicator"><i className="codicon codicon-check" /> API key configured</span>
            <button className="settings-btn settings-btn-danger" onClick={clearApiKey} disabled={saving}>
              {saving ? "Removing..." : "Remove Key"}
            </button>
          </div>
        ) : (
          <div className="settings-key-input-row">
            <input className="settings-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." onKeyDown={(e) => e.key === "Enter" && saveApiKey()} />
            <button className="settings-btn settings-btn-primary" onClick={saveApiKey} disabled={saving || !apiKey.trim()}>
              {saving ? "Saving..." : "Save Key"}
            </button>
          </div>
        )}
        <p className="settings-hint">Your API key is encrypted at rest (AES-256-GCM) and never stored in browser localStorage. Get a key at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com</a>.</p>
        {status && <p className={`settings-status ${status.startsWith("Error") ? "settings-status-error" : ""}`}>{status}</p>}
      </div>
    </div>
  );
}

// ── About tab ──

function AboutTab() {
  const [activeSection, setActiveSection] = useState<"terms" | "privacy" | "oss" | "">("");

  return (
    <div className="settings-tab-content">
      <div className="settings-about-header">
        <svg className="settings-about-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE" />
        </svg>
        <h2 className="settings-about-title">Harness</h2>
        <p className="settings-about-subtitle">AI-powered coding workspace<br />Powered by DeepSeek</p>
        <p className="settings-about-version">Version 0.0.1</p>
      </div>

      <div className="settings-about-sections">
        <button className={`settings-about-section-btn ${activeSection === "terms" ? "active" : ""}`} onClick={() => setActiveSection((s) => s === "terms" ? "" : "terms")}>
          <i className={`codicon ${activeSection === "terms" ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
          Terms of Service
        </button>
        {activeSection === "terms" && (
          <div className="settings-about-text">
            <p><strong>Last updated: July 2026</strong></p>
            <p>By using Harness ("the Software"), you agree to these terms.</p>
            <h4>1. License</h4>
            <p>The Software is provided for personal and commercial use. You may install, run, and use the Software on any number of devices you own or control.</p>
            <h4>2. AI Services</h4>
            <p>The Software integrates with third-party AI API providers (such as DeepSeek). Use of AI features requires a valid API key from the respective provider. You are responsible for all API usage costs, compliance with the provider's terms, and any content generated through AI interactions.</p>
            <h4>3. User Responsibilities</h4>
            <p>You are responsible for:</p>
            <ul>
              <li>All code, files, and content you create or modify using the Software.</li>
              <li>Keeping your API keys secure and confidential.</li>
              <li>Complying with all applicable laws and regulations.</li>
            </ul>
            <h4>4. Disclaimer</h4>
            <p>THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. AI-GENERATED CONTENT MAY BE INACCURATE OR INCOMPLETE. ALWAYS REVIEW AI OUTPUT BEFORE USE.</p>
            <h4>5. Limitation of Liability</h4>
            <p>In no event shall the authors be liable for any damages arising from the use or inability to use the Software, including but not limited to data loss, API costs, or damages resulting from AI-generated code.</p>
          </div>
        )}

        <button className={`settings-about-section-btn ${activeSection === "privacy" ? "active" : ""}`} onClick={() => setActiveSection((s) => s === "privacy" ? "" : "privacy")}>
          <i className={`codicon ${activeSection === "privacy" ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
          Privacy Policy
        </button>
        {activeSection === "privacy" && (
          <div className="settings-about-text">
            <p><strong>Last updated: July 2026</strong></p>
            <h4>1. Data Collection</h4>
            <p>Harness does <strong>not</strong> collect telemetry, analytics, or usage data. No data is sent to Harness developers or any third-party analytics services.</p>
            <h4>2. Data Storage</h4>
            <p>All user data is stored locally on your machine:</p>
            <ul>
              <li><strong>API keys</strong> — Encrypted with AES-256-GCM using a machine-specific key at <code>~/.harness/store/api-keys.enc</code>. Never stored in browser localStorage. Transmitted only to DeepSeek API as Bearer token.</li>
              <li><strong>Chat history & preferences</strong> — Stored in browser localStorage, synced to <code>~/.harness/store/client-state.json</code> on disk.</li>
              <li><strong>Agent memory</strong> — SQLite database at <code>~/.harness/store/memory.db</code> (WAL mode).</li>
              <li><strong>File tracking metadata</strong> — <code>~/.harness/store/file-tracking.json</code> (file paths, sizes, checksums; no file contents).</li>
              <li><strong>Port discovery files</strong> — OS temp directory; runtime only, not persisted.</li>
            </ul>
            <p>Deleting <code>~/.harness/</code> removes all Harness data.</p>
            <h4>3. External Data Transmission</h4>
            <p>Project source code (files, file tree, prompts) is transmitted to DeepSeek's API (<code>api.deepseek.com</code>) as part of agent operations. No code is transmitted anywhere else.</p>
            <h4>4. Debug Logging (Opt-in)</h4>
            <p>Agent debug logs are stored locally at <code>&lt;project&gt;/.harness-debug/</code> and auto-deleted after 7 days. This directory is <code>.gitignore</code>'d.</p>
            <h4>5. Your Rights</h4>
            <p>All data resides on your machine. You can delete all data by removing the <code>~/.harness/</code> directory. API keys can be removed at any time via Settings.</p>
          </div>
        )}

        <button className={`settings-about-section-btn ${activeSection === "oss" ? "active" : ""}`} onClick={() => setActiveSection((s) => s === "oss" ? "" : "oss")}>
          <i className={`codicon ${activeSection === "oss" ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
          Open Source Software Statement
        </button>
        {activeSection === "oss" && (
          <div className="settings-about-text">
            <p>This product includes software developed by the following open source projects:</p>
            <h4>Runtime Dependencies</h4>
            <ul className="settings-oss-list">
              <li><strong>React</strong> (MIT) — <a href="https://react.dev" target="_blank" rel="noopener">react.dev</a></li>
              <li><strong>Express</strong> (MIT) — <a href="https://expressjs.com" target="_blank" rel="noopener">expressjs.com</a></li>
              <li><strong>Monaco Editor</strong> (MIT) — <a href="https://microsoft.github.io/monaco-editor/" target="_blank" rel="noopener">microsoft.github.io/monaco-editor</a></li>
              <li><strong>xterm.js</strong> (MIT) — <a href="https://xtermjs.org" target="_blank" rel="noopener">xtermjs.org</a></li>
              <li><strong>TypeScript</strong> (Apache-2.0) — <a href="https://www.typescriptlang.org" target="_blank" rel="noopener">typescriptlang.org</a></li>
              <li><strong>Vite</strong> (MIT) — <a href="https://vitejs.dev" target="_blank" rel="noopener">vitejs.dev</a></li>
              <li><strong>Electron</strong> (MIT) — <a href="https://www.electronjs.org" target="_blank" rel="noopener">electronjs.org</a></li>
              <li><strong>better-sqlite3</strong> (MIT) — <a href="https://github.com/WiseLibs/better-sqlite3" target="_blank" rel="noopener">github.com/WiseLibs/better-sqlite3</a></li>
              <li><strong>node-pty</strong> (MIT) — <a href="https://github.com/lydell/node-pty" target="_blank" rel="noopener">github.com/lydell/node-pty</a></li>
              <li><strong>dotenv</strong> (BSD-2-Clause) — <a href="https://github.com/motdotla/dotenv" target="_blank" rel="noopener">github.com/motdotla/dotenv</a></li>
              <li><strong>ws</strong> (MIT) — <a href="https://github.com/websockets/ws" target="_blank" rel="noopener">github.com/websockets/ws</a></li>
              <li><strong>tsx</strong> (MIT) — <a href="https://github.com/privatenumber/tsx" target="_blank" rel="noopener">github.com/privatenumber/tsx</a></li>
              <li><strong>material-icon-theme</strong> (MIT) — File icons</li>
              <li><strong>@vscode/codicons</strong> (CC-BY-4.0) — Icon font</li>
            </ul>
            <h4>Development Dependencies</h4>
            <ul className="settings-oss-list">
              <li><strong>electron-builder</strong> (MIT)</li>
              <li><strong>electron-rebuild</strong> (MIT)</li>
              <li><strong>Vitest</strong> (MIT)</li>
              <li><strong>Supertest</strong> (MIT)</li>
              <li><strong>sharp</strong> (Apache-2.0)</li>
              <li><strong>concurrently</strong> (MIT)</li>
              <li><strong>png-to-ico</strong> (MIT)</li>
              <li><strong>to-ico</strong> (MIT)</li>
              <li><strong>rcedit</strong> (MIT)</li>
            </ul>
            <p style={{ marginTop: 12, fontStyle: "italic" }}>Full license texts are available in each package's <code>node_modules/&lt;package&gt;/LICENSE</code> file.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Settings Dialog ──

export default function SettingsDialog({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("model");

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog-box settings-dialog-box">
        <div className="dialog-title">
          <span>Settings</span>
          <button className="dialog-title-close" onClick={onClose}><i className="codicon codicon-close" /></button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === "model" ? "active" : ""}`} onClick={() => setTab("model")}>
            <i className="codicon codicon-server" /> Model &amp; API Key
          </button>
          <button className={`settings-tab ${tab === "about" ? "active" : ""}`} onClick={() => setTab("about")}>
            <i className="codicon codicon-info" /> About
          </button>
        </div>

        <div className="dialog-body settings-dialog-body">
          {tab === "model" && <ModelApiTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}
