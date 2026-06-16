# Debug Session: viewport-scale-height-bug

**Status**: [OPEN]
**Created**: 2026-06-16
**Symptom**: Browser viewport preview fits width but doesn't fit height. Horizontal scroll appears when it shouldn't. The page content doesn't extend to the bottom of the viewport preview.
**Affected File**: `client/src/panes/BrowserView.tsx`, `client/src/App.css`
**Session ID**: `viewport-scale-height-bug`

## Hypotheses

| # | Hypothesis | Instrumentation Point |
|---|-----------|----------------------|
| H1 | `transform: scale()` creates a visual transform but the shell's layout box reflects the unscaled frame size, causing the stage to overflow with scrollbars | Measure shell clientWidth/clientHeight vs stage clientWidth/clientHeight after scale |
| H2 | ResizeObserver captures correct stage dimensions but `viewportScale` math is wrong when height is the constraining factor | Log availableWidth, availableHeight, scaleByWidth, scaleByHeight, resulting viewportScale on each resize |
| H3 | Shell has extra padding/margin/border not accounted for in the scale calculation | Log shell.getBoundingClientRect() vs computed style width/height |
| H4 | Frame's actual rendered layout box (unscaled) pushes past the shell boundary, enabling stage scroll | Log frame scrollWidth/scrollHeight vs shell clientWidth/clientHeight |

## Evidence Log

| # | TS | Hypothesis | Finding |
|---|-----|-----------|---------|
| 1 | 1781589691052 | H1 | frame=512×320(post-transform), shell=512×320, stage overflow=hidden. Scroll=1278×798. Transform renders correctly. |
| 2 | 1781589754741 | H1/H2 | frame=694×434(post-transform), shell=694×434. Scale constrained by height (0.5425). Math correct. |
| 3 | 1781590051861 | — | (interim, no transform) frame scaled directly to 694×434, scroll=692×432. Viewport halved — wrong. |
| 4 | 1781590089027 | H1 | Reverted to transform+**position:absolute**. Frame=694×434(post-transform), scroll=1278×798. Correct. |

## Resolution

**Root Cause (H1 confirmed):** `transform: scale()` in CSS is a visual-only transform. The frame's layout box stays at the pre-transform px, causing layout overflow in every ancestor flex container regardless of `overflow: hidden` settings. This produced unpredictable horizontal scrollbars and content clipping.

**Fix (Iteration 2):** Removed CSS transform scaling entirely. The preview now renders at the full chosen viewport px inside a scrollable stage (`overflow: auto`). This matches how Edge DevTools device toolbar works — the iframe/webview gets explicit `width`/`height` attributes at the target device dimensions, and the stage scrolls to show different parts if the pane is smaller than the viewport.

**Changes:**
- [BrowserView.tsx](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx): Removed `viewportScale`, `viewportShellStyle`, `viewportFrameStyle`, `viewportStageRef`, `viewportStageSize`, and ResizeObserver effect
- Frame now gets `width` and `minHeight` at full viewport px; iframe gets `width`/`height` attributes
- [App.css](file:///d:/Work%20Projects/Harness/client/src/App.css): Removed `.browser-viewport-shell`. Stage changed to `overflow: auto; align-items: flex-start`. Frame has simple `flex: 0 0 auto; overflow: hidden`
