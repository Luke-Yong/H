// Pending browser dialog store.
//
// The in-page alert/confirm/prompt interceptor (BrowserView.tsx) replaces the
// native dialogs and blocks the page on a synchronous XHR long-poll to
// POST /_h-dialog/await. The browser sub-agent answers via the
// browser_respond_dialog tool, which resolves the poll and lets the page
// continue with the agent-provided value. No human interaction required.

export interface PendingBrowserDialog {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue: string;
  createdAt: number;
  /** Last time the page polled for an answer — used for TTL cleanup. */
  lastPollAt: number;
  /** null = not answered yet. */
  answer: string | null;
  /** Resolvers for in-flight polls. */
  waiters: Array<(value: string) => void>;
}

const dialogs = new Map<string, PendingBrowserDialog>();

/** How long each /_h-dialog/await request is held before returning "pending". */
const POLL_HOLD_MS = 15_000;
/** Drop dialogs whose page stopped polling (navigated away / abandoned). */
const DIALOG_TTL_MS = 2 * 60_000;
/** Bound memory in pathological cases (many tabs × dialogs). */
const MAX_DIALOGS = 50;

// Periodic cleanup of abandoned dialogs (page navigated away, agent moved on).
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, d] of dialogs) {
    if (now - d.lastPollAt > DIALOG_TTL_MS) {
      const ws = d.waiters.slice();
      d.waiters.length = 0;
      for (const w of ws) w("");
      dialogs.delete(id);
    }
  }
}, 30_000);
cleanupTimer.unref?.();

export function getBrowserDialog(id: string): PendingBrowserDialog | null {
  return dialogs.get(id) ?? null;
}

/** Most recently registered dialog that has not been answered yet. */
export function getLatestPendingBrowserDialog(): PendingBrowserDialog | null {
  let latest: PendingBrowserDialog | null = null;
  for (const d of dialogs.values()) {
    if (d.answer !== null) continue;
    if (!latest || d.createdAt > latest.createdAt) latest = d;
  }
  return latest;
}

/**
 * Register (or refresh) a dialog and long-poll for the agent's answer.
 * Resolves with:
 *   { status: "pending" }  → held for `holdMs`, page should poll again
 *   { status: "answered", value } → agent responded; consumed on first poll
 *   { status: "gone" }     → dialog expired/evicted, page should auto-dismiss
 */
export function awaitBrowserDialogAnswer(
  id: string,
  type: "alert" | "confirm" | "prompt",
  message: string,
  defaultValue: string,
  holdMs: number = POLL_HOLD_MS,
): Promise<{ status: "pending" } | { status: "answered"; value: string } | { status: "gone" }> {
  const now = Date.now();
  let d = dialogs.get(id);
  if (!d) {
    if (dialogs.size >= MAX_DIALOGS) {
      let oldest: PendingBrowserDialog | null = null;
      for (const cand of dialogs.values()) {
        if (!oldest || cand.createdAt < oldest.createdAt) oldest = cand;
      }
      if (oldest) dialogs.delete(oldest.id);
    }
    d = { id, type, message, defaultValue, createdAt: now, lastPollAt: now, answer: null, waiters: [] };
    dialogs.set(id, d);
  } else {
    d.lastPollAt = now;
    d.type = type;
    d.message = message;
    d.defaultValue = defaultValue;
  }

  if (d.answer !== null) {
    const answer = d.answer;
    dialogs.delete(id); // one-shot: consumed on the first poll after answering
    return Promise.resolve({ status: "answered", value: answer });
  }

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const waiter = (value: string) => {
      clearTimeout(timer);
      const idx = d!.waiters.indexOf(waiter);
      if (idx >= 0) d!.waiters.splice(idx, 1);
      dialogs.delete(id);
      resolve({ status: "answered", value });
    };
    timer = setTimeout(() => {
      const idx = d!.waiters.indexOf(waiter);
      if (idx >= 0) d!.waiters.splice(idx, 1);
      // Dialog still pending — the page should poll again.
      resolve({ status: "pending" });
    }, holdMs);
    d!.waiters.push(waiter);
  });
}

/** Set the agent's answer, resolving all in-flight polls for that dialog. */
export function respondToBrowserDialog(
  id: string,
  value: string,
): { ok: true } | { ok: false; error: string } {
  const d = dialogs.get(id);
  if (!d) return { ok: false, error: `No pending browser dialog with id "${id}".` };
  d.answer = value;
  const ws = d.waiters.slice();
  d.waiters.length = 0;
  for (const w of ws) w(value);
  return { ok: true };
}
