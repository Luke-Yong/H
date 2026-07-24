// Syncs harneess-prefixed localStorage keys to ~/.harness/client-state.json
// on the server. This ensures data survives reinstalls since it's stored
// in the user's home directory, not Electron's ephemeral userData dir.

const LOCALSTORAGE_PREFIX = "harness";
const SAVE_INTERVAL_MS = 30_000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Record<string, string> | null = null;

function gatherState(): Record<string, string> {
  const state: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LOCALSTORAGE_PREFIX)) {
      const val = localStorage.getItem(key);
      if (val !== null) state[key] = val;
    }
  }
  return state;
}

function saveState() {
  const state = gatherState();
  // Avoid sending the same data repeatedly
  if (pendingSave && JSON.stringify(pendingSave) === JSON.stringify(state)) return;
  pendingSave = state;

  fetch("/api/client/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
    keepalive: true,
  }).catch(() => {});
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveState();
    saveTimer = null;
  }, SAVE_INTERVAL_MS);
}

export async function loadPersistedState(): Promise<void> {
  try {
    const res = await fetch("/api/client/state");
    if (!res.ok) return;
    const state: Record<string, string> = await res.json();
    if (!state || Object.keys(state).length === 0) return;

    for (const [key, value] of Object.entries(state)) {
      // Only restore if the key doesn't already exist in localStorage
      // (localStorage takes precedence as it's the live session data)
      if (localStorage.getItem(key) === null && key.startsWith(LOCALSTORAGE_PREFIX)) {
        try {
          localStorage.setItem(key, value);
        } catch {}
      }
    }
  } catch {}
}

export function startAutoSave(): () => void {
  const onBeforeUnload = () => saveState();
  window.addEventListener("beforeunload", onBeforeUnload);

  // Periodic save (in case of crashes)
  const intervalId = setInterval(() => saveState(), SAVE_INTERVAL_MS);

  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
    clearInterval(intervalId);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  };
}

// Trigger a save after significant state changes
export function triggerSave(): void {
  scheduleSave();
}
