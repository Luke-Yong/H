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
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("h-model") || "deepseek-chat");
  const [isThinking, setIsThinking] = useState(() => localStorage.getItem("h-thinking") === "true");
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

  useEffect(() => {
    const handleApiKeyChange = () => { void refreshConfig(); };
    window.addEventListener("api-key-changed", handleApiKeyChange);
    return () => window.removeEventListener("api-key-changed", handleApiKeyChange);
  }, [refreshConfig]);

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
      window.dispatchEvent(new CustomEvent("api-key-changed"));
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
      window.dispatchEvent(new CustomEvent("api-key-changed"));
      setStatus("API key removed.");
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally { setSaving(false); }
  }, [refreshConfig]);

  const handleModelSave = () => {
    localStorage.setItem("h-model", selectedModel.trim());
    setStatus("Model saved.");
  };

  const handleThinkingToggle = () => {
    const next = !isThinking;
    setIsThinking(next);
    localStorage.setItem("h-thinking", String(next));
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
          <rect x="3" y="2" width="5.5" height="20" rx="2.75" fill="#4D6BFE"/><rect x="15.5" y="2" width="5.5" height="20" rx="2.75" fill="#4D6BFE"/><rect x="3" y="9.5" width="18" height="5" rx="2.5" fill="#4D6BFE"/>
        </svg>
        <h2 className="settings-about-title"></h2>
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
            <p>By using H ("the Software"), you agree to these terms.</p>
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
            <p>H does <strong>not</strong> collect telemetry, analytics, or usage data. No data is sent to H developers or any third-party analytics services.</p>
            <h4>2. Data Storage</h4>
            <p>All user data is stored locally on your machine:</p>
            <ul>
              <li><strong>API keys</strong> — Encrypted with AES-256-GCM using a machine-specific key at <code>~/.h/store/api-keys.enc</code>. Never stored in browser localStorage. Transmitted only to DeepSeek API as Bearer token.</li>
              <li><strong>Chat history & preferences</strong> — Stored in browser localStorage, synced to <code>~/.h/store/client-state.json</code> on disk.</li>
              <li><strong>Agent memory</strong> — SQLite database at <code>~/.h/store/memory.db</code> (WAL mode).</li>
              <li><strong>File tracking metadata</strong> — <code>~/.h/store/file-tracking.json</code> (file paths, sizes, checksums; no file contents).</li>
              <li><strong>Port discovery files</strong> — OS temp directory; runtime only, not persisted.</li>
            </ul>
            <p>Deleting <code>~/.h/</code> removes all H data.</p>
            <h4>3. External Data Transmission</h4>
            <p>Project source code (files, file tree, prompts) is transmitted to DeepSeek's API (<code>api.deepseek.com</code>) as part of agent operations. No code is transmitted anywhere else.</p>
            <h4>4. Your Rights</h4>
            <p>All data resides on your machine. You can delete all data by removing the <code>~/.h/</code> directory. API keys can be removed at any time via Settings.</p>
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
              <li><strong>@vitejs/plugin-react-swc</strong> (MIT)</li>
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
