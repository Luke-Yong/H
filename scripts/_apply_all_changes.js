const fs = require('fs');
const file = 'd:/Work Projects/Harness/client/src/panes/AgentConsole.tsx';
let content = fs.readFileSync(file, 'utf8');

// Change 1: Add storage event listener after activePreset effect
const old1 = `  }, [activePreset]);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);`;
const new1 = `  }, [activePreset]);

  // Listen for localStorage changes from other windows (e.g. settings window)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "harness-presets") {
        setPresets(getStoredPresets());
      } else if (e.key === "harness-active-preset") {
        const newId = localStorage.getItem("harness-active-preset") || "";
        setActivePresetId(newId);
        if (!newId) {
          setSelectedModel(getStoredModel());
          setIsThinking(getStoredThinking());
        }
      } else if (e.key === "harness-model") {
        if (!activePresetId) setSelectedModel(getStoredModel());
      } else if (e.key === "harness-thinking") {
        if (!activePresetId) setIsThinking(getStoredThinking());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [activePresetId]);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);`;
content = content.replace(old1, new1);
console.log('1. storage listener:', content.includes('handleStorage'));

// Change 2: Clear model/thinking on delete active preset
const old2 = `    if (activePresetId === id) {
      setActivePresetId("");
      localStorage.removeItem("harness-active-preset");
    }
  }, [presets, activePresetId]);`;
const new2 = `    if (activePresetId === id) {
      setActivePresetId("");
      localStorage.removeItem("harness-active-preset");
      // Clear model/thinking so the UI doesn't show stale deleted preset
      setSelectedModel("");
      setIsThinking(false);
      localStorage.removeItem("harness-model");
      localStorage.removeItem("harness-thinking");
    }
  }, [presets, activePresetId]);`;
content = content.replace(old2, new2);
console.log('2. deletePreset clear:', content.includes('stale deleted preset'));

// Change 3: Write model/thinking to localStorage on selectPreset
const old3 = `      setEditIsThinking(p.thinking);
      setEditModelInput(p.model);
    }
    if (!editingModelRef.current) setModelPickerOpen(false);`;
const new3 = `      setEditIsThinking(p.thinking);
      setEditModelInput(p.model);
      localStorage.setItem("harness-model", p.model);
      localStorage.setItem("harness-thinking", String(p.thinking));
    }
    if (!editingModelRef.current) setModelPickerOpen(false);`;
content = content.replace(old3, new3);
console.log('3. selectPreset localStorage:', content.includes('setItem("harness-model", p.model)'));

// Change 4: Remove apiKeyConfigured guard from button onClick, refresh on open
const old4 = `onClick={() => { if (!apiKeyConfigured) return; setModelPickerOpen((v) => { if (!v) { setEditingModel(false); setEditingApiKey(false); } return !v; }); void refreshAgentConfig(); }}`;
const new4 = `onClick={() => { setModelPickerOpen((v) => { if (!v) { setEditingModel(false); setEditingApiKey(false); setPresets(getStoredPresets()); const aid = localStorage.getItem("harness-active-preset") || ""; if (aid) setActivePresetId(aid); else { setSelectedModel(getStoredModel()); setIsThinking(getStoredThinking()); } } return !v; }); void refreshAgentConfig(); }}`;
content = content.replace(old4, new4);
console.log('4. button guard removed:', !content.includes('if (!apiKeyConfigured) return'));

// Change 5: Show popup even without API key - replace the popup condition
const old5 = `            {modelPickerOpen && apiKeyConfigured && (
              <div className="agent-model-popup">
                <div className="agent-model-popup-title">Saved Configurations</div>`;
const new5 = `            {modelPickerOpen && (
              (!apiKeyConfigured) ? (
                <div className="agent-model-popup">
                  <div className="agent-model-popup-title">Add API Key</div>
                  <div className="agent-model-apikey-edit">
                    <input
                      className="agent-model-apikey-input"
                      type="password"
                      placeholder="sk-..."
                      value={tempApiKey}
                      onChange={(e) => setTempApiKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !savingApiKey) void saveApiKey(); }}
                      autoFocus
                    />
                    <button className="agent-model-apikey-save" onClick={() => { void saveApiKey(); }} disabled={!tempApiKey.trim() || savingApiKey}>Save</button>
                  </div>
                  <div className="agent-mention-hint" style={{marginTop: 8}}>Add a DeepSeek API key to start chatting. Get one at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener" style={{color: "#4D6BFE"}}>platform.deepseek.com</a>.</div>
                </div>
              ) : (
              <div className="agent-model-popup">
                <div className="agent-model-popup-title">Saved Configurations</div>`;
content = content.replace(old5, new5);
console.log('5. popup condition:', content.includes('(!apiKeyConfigured)'));

// Change 6: Close the ternary at the popup end
const old6 = `              </div>
            )}`;
const new6 = `              </div>
            ))}`;
// Only replace the one near the model popup - find the specific context
const marker = `className="agent-model-item" onClick={() => setEditingModel(true)}>`;
const markerIdx = content.indexOf(marker);
if (markerIdx >= 0) {
  // Find the closing )} after the marker
  const afterMarker = content.substring(markerIdx);
  const closingIdx = afterMarker.indexOf(`              </div>\n            )}`);
  if (closingIdx >= 0) {
    const before = content.substring(0, markerIdx + closingIdx);
    const after = content.substring(markerIdx + closingIdx + `              </div>\n            )}`.length);
    content = before + `              </div>\n            ))}` + after;
    console.log('6. ternary closing: true');
  } else {
    console.log('6. ternary closing: NOT FOUND');
  }
} else {
  console.log('6. marker not found');
}

fs.writeFileSync(file, content, 'utf8');
console.log('Done');
