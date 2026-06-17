# Debug Session: iframe-url-not-updating

**Status:** [OPEN]
**Bug:** Flask SPA navigation (`/mrt/<path>`, `/bus/<path>`, `/journey-planner`) does not update the browser address bar. Only updates when refresh button is clicked.
**Environment:** React + Vite dev server (localhost:5174), Flask backend (likely localhost:5000) — cross-origin iframe scenario.

## Hypotheses

| ID | Hypothesis | Observation Point |
|----|------------|-------------------|
| **A** | Cross-origin sandbox: iframe is cross-origin, `contentDocument` access throws SecurityError silently caught | Log whether polling's `catch` block is hit |
| **B** | `useEffect` with polling never fires or iframe ref is stale/null | Log at effect mount time |
| **C** | SPA uses `pushState`/`replaceState`, polling detects URL change but React state update gets overridden | Log detected URL vs liveUrlRef |
| **D** | iframe `sandbox` attribute blocks location changes | Check sandbox attr value |

## Run Log
- **pre** (instrumentation phase): TBD
- **post-fix** (after fix): TBD

