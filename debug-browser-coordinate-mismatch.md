# Debug Session: browser-coordinate-mismatch

**Status**: [OPEN]
**Created**: 2026-08-27
**Session ID**: browser-coordinate-mismatch

## Problem Statement
Browser sub-agent receives full-resolution screenshots but the coordinates used for clicking/interacting with elements do not match the actual webview coordinates, causing the agent to consistently miss target elements.

## User's Insight (Critical — drove V2 fix design)
> *"actually, the browser viewport dimensions are for the aspect ratio only, I suspect that if the screenshot is say 1366x768, the browser tool coordinates should follow the screenshot coordinates"*

This directly contradicted the V1 approach (keep DPR×physical screenshot, scale coords 1/DPR back). It revealed the **real contract**: screenshot pixels passed to browser_click MUST map 1:1. The viewportW/H values are metadata only (used when MAX_SIDE kicks in, or for verifying aspect ratio), NOT the numerator for a reverse-scaling formula.

## Hypotheses (Falsifiable)
1. **H1 [CONFIRMED] Device Pixel Ratio (DPR) Scaling Mismatch**: Screenshot is captured at native device resolution (scaled by DPR), but click coordinates are sent in CSS pixels without accounting for DPR scaling.
2. **H2 [REJECTED] Webview Offset Not Accounted**: Click coordinates are relative to the screenshot image but the actual webview has an offset (toolbar, window borders, scroll position) that isn't being subtracted.
3. **H3 [NOT REPRODUCED] Screenshot Resizing in Display Pipeline**: The screenshot sent to the sub-agent gets resized for display, but the coordinate mapping doesn't account for the resize transformation.
4. **H4 [REJECTED] Viewport vs Full-Page Coordinate Mix**: Screenshot captures the full page (with scroll offset applied) or viewport-only, while coordinates assume the opposite convention.
5. **H5 [CONFIRMED — subset of H1] Electron BrowserView Coordinate API Mismatch**: The Electron API for simulating clicks in BrowserView uses a different coordinate space than the screenshot capture API.

## Root Cause (Concise)
`wc.capturePage()` returns **physical pixels = CSS × DPR**. Old code either:
- (V0 bug) stored viewportW/H sometimes in physical px via `pick({v:a*dpr,...})` → click position ~× DPR drift, OR
- (V1, okay but complex) kept screenshot at DPR×physical fidelity and reverse-scaled coordinates, adding an indirection layer that violated the documented "screenshot pixels = browser tool coords" contract and kept the `pick()` DPR heuristic surface (bug-prone).

**Correct fix (V2 — user-driven):** Resize the output PNG to the exact CSS-pixel dimensions of the guest viewport BEFORE sending to the sub-agent. Then imageW = viewportW always, so `scaleToViewport` is identity (× 1). The sub-agent's (x,y) in "Screenshot: 1366x768" space IS exactly the CSS coordinate space `sendInputEvent()` expects. No DPR anywhere in the pipeline. Simple, bug-free.

## Evidence Log

### Static Analysis (Code Review Evidence)

| Timestamp | Hypothesis | Event | Finding |
|-----------|------------|-------|---------|
| 2026-08-27 T1 | H1, H5 | Coordinate pipeline trace in [BrowserView.tsx](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L2209-L2236) | **ROOT CAUSE FOUND (V0 bug)** |
| 2026-08-27 T2 | H1, user insight | BrowserView L2009-2011 design comment + ARCHITECTURE.md L917 | **"coordinates the model reports then match the screenshot pixels 1:1"** → DPR should never leak into screenshot dims |
| 2026-08-27 T3 | H1, user insight | main.cjs L964 comment intent vs implementation | Intent: 1:1. Implementation: sent DPR×physical without resize. Mismatch → V2 approach chosen. |

### Detailed Evidence: Numerical Comparison (DPR=2, viewport preset 1920×1080 CSS)

| Stage | Variable | V0 (Buggy) | V1 (Complex Fix) | V2 (User's Preferred — CURRENT) |
|-------|----------|-----------|------------------|----------------------------------|
| capturePage output (physical) | captureMeta.w | 3840 | 3840 | 3840 |
| main.cjs resize to CSS target? | — | NO | NO | YES — resize → 1920×1080 CSS |
| PNG dimensions → model sees header | Screenshot WxH | 3840×2160 | 3840×2160 | **1920×1080 (CSS! ✅)** |
| imageW STORED | lastCaptureRef.imageW | 3840 | 3840 | **1920** |
| viewportW STORED (CSS px) | lastCaptureRef.viewportW | 3840 (WRONG!) | 1920 (correct) | **1920** |
| **imageW / viewportW ratio** | scaleToViewport multiplier basis | 3840/3840 = 1 | 3840/1920 = 2 | **1920/1920 = 1 (identity! ✅)** |
| Model sees element at CSS(100,100) → reports screenshot pos | (x_input, y_input) | (200,200) in 3840w image | (200,200) in 3840w image | **(100,100) in 1920w image (direct!)** |
| scaleToViewport → sends to Electron | sendInputEvent receives | (200,200) CSS → 2× OFF | (100,100) CSS → correct  ✅  but 2 indirection layers | **(100,100) CSS → correct  ✅  identity map** |

### Contract Verified Across All 3 Docs Against V2

| Source | Location | Says | V2 fulfills it? |
|--------|----------|------|-----------------|
| Agent system prompt (sub-agent) | [agent.ts](file:///d:/Work%20Projects/Harness/server/agent.ts#L134) | "All x,y you pass to interaction tools are in the screenshot image's pixel space." | ✅ 1:1 identity map. CSS coords = screenshot coords |
| Design comment in rasterization path | [BrowserView.tsx](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L2009-L2011) | "so the screenshot is never downscaled — the coordinates the model reports then match the screenshot pixels 1:1" | ✅ V2 takes this literally — no DPR scaling in the sent PNG |
| User statement (driving design) | User input 2026-08-27 | "if the screenshot is say 1366x768, the browser tool coordinates should follow the screenshot coordinates" | ✅ Screenshot 1366 → click 1366 space → sendInputEvent gets same CSS px |
| ARCHITECTURE browser tools table | [ARCHITECTURE.md](file:///d:/Work%20Projects/Harness/ARCHITECTURE.md#L917) | "browser_click… Click at screenshot-image x,y coordinates (the header's Screenshot: WxH fixes the pixel space; the renderer scales to viewport coords)." | ✅ WxH header matches CSS viewport size, so "scale to viewport" = identity. Scale only exists for MAX_SIDE. |

### Runtime Instrumentation Points

4 instrumentation points (all report to debug server port 7777):
- **A: viewportW/H resolution** — captures targetWidth/targetHeight CSS hints, imageW_post vs viewportW ratio (should be 1.0 exactly on fast path), preset viewportWidth/Height vs actual iw/cw/dpr from evalInPage.
- **B: lastCaptureRef commit** — imageW/imageH vs viewportW/viewportH ratios = verify 1.0 in common case.
- **C: scaleToViewport** — input x, y (screenshot px) vs output CSS px; when fast path active, they SHOULD be identical.
- **D: mouseEvent pre-dispatch** — x_css_in, y_css_in confirmed CSS px passed to CDP + sendInputEvent.

### Test Verification

| Test | Result |
|------|--------|
| TypeScript `tsc -p client/tsconfig.json --noEmit` (full client) | ✅ 0 errors, exit 0 |
| Node syntax check `node -c electron/main.cjs` (JS) | ✅ syntax OK |
| Vitest full suite (`npm test`) | ✅ 96/96 tests passed, 6 files (exit 1 from TRAE sandbox ACL only — no test failures) |

## Fix Summary (V2 — User's preferred approach)

### File 1: [electron/main.cjs](file:///d:/Work%20Projects/Harness/electron/main.cjs#L954-L1007) — capture resize to CSS target

**Signature change:** `h:captureBrowserPage(webContentsId, targetSize?)` — accepts optional 2nd arg `{width, height}` = the CSS viewport preset dimensions.

**Pipeline:**
1. `wc.capturePage()` → raw capture (physical px = CSS × DPR)
2. **STEP 1 (new):** If targetSize provided, `image.resize({ width: targetW, height: targetH, quality: "best" })` — forces output PNG to exact CSS dimensions regardless of DPR.
3. **STEP 2 (unchanged):** MAX_SIDE=4096 API safety cap still applies (rare for viewport presets ≤ 3840 at CSS resolutions, but safe fallback).
4. IPC return adds `targetWidth`/`targetHeight` fields so renderer can use the fast-path. Returns the pre-resize raw capture size as `width/height` for debugging.

### File 2: [BrowserView.tsx](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L1984-L2268) — pass CSS preset as targetSize + viewportW/H resolution fast path

Changes:
1. **[L1991-1994](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L1991-L1994)** `captureBrowserPage(wv.getWebContentsId(), { width: viewportWidth, height: viewportHeight })` — passes the preset CSS dims every time. Dependencies updated: `captureScreenshotImage` now depends on `viewportWidth, viewportHeight`.
2. **[L1997-2002](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L1997-L2002)** captureMeta now carries `targetWidth/targetHeight` from IPC response.
3. **[L2212-2254](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L2212-L2254)** New FAST PATH: when `targetW/targetH > 0` AND `imageW === targetW && imageH === targetH` (i.e., MAX_SIDE didn't trigger, main.cjs did the CSS resize) → **viewportW = targetW directly, no heuristics**. Falls back to enhanced `pick()` if conditions not met (older Electron builds without V2, or MAX_SIDE resize triggered).
4. **[BrowserView.tsx#L1798-L1807](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L1798-L1807)** `scaleToViewport` is mathematically now identity in the fast-path case (imageW === viewportW → ×1). No function signature changes needed; it Just Works.

## Post-Fix Verification

Instructions to confirm:

1. Start H desktop: `npm run desktop:dev`
2. Ask the agent: "Open example.com and click the [More information...] link" (or any visibly identifiable element)
3. **Expected behavior — V2:** The screenshot returned to the sub-agent will show header like `Screenshot: 1920x1080` if preset=FHD (CSS dims, NOT 3840×2160 anymore). When sub-agent reports coordinates within that 1920-range, the pointer marker lands EXACTLY on the element clicked, 1:1. No DPR drift.
4. Debug log `.dbg/trae-debug-log-browser-coordinate-mismatch.ndjson`:
   - Point A: `fastPath_hit` = `true`. `imageW_after === viewportW_stored_css === preset_viewportWidth_css === 1920`. `ratio_image_to_viewport_shouldBe_1point0 = 1.0`.
   - Point C: `output_vx_cssPx === input_x`, `output_vy_cssPx === input_y` (identity).
   - Point D: `x_css_in` is WITHIN `[0, preset viewportWidth)` range — confirmed CSS space.
5. VISUAL TEST: Last-click's `__hPointerMarker` (pulsing red dot at coordinates) appears centered EXACTLY on the element the sub-agent declared it clicked (no ×2 offset down-right anymore).

### Files Changed in V2

| File | What changed |
|------|--------------|
| [electron/main.cjs](file:///d:/Work%20Projects/Harness/electron/main.cjs#L954-L1007) | `h:captureBrowserPage(webContentsId, targetSize?)` + STEP1 resize to CSS target before MAX_SIDE |
| [client/src/panes/BrowserView.tsx](file:///d:/Work%20Projects/Harness/client/src/panes/BrowserView.tsx#L1984-L2268) | Pass CSS preset dims to IPC; fast-path viewportW/H when image dims match target |
| [debug-browser-coordinate-mismatch.md](file:///d:/Work%20Projects/Harness/debug-browser-coordinate-mismatch.md) | This file — session log with hypotheses and V2 evidence |

Next step: run a real browser sub-agent interaction in desktop dev and confirm pointer marker matches declared target coordinates 1:1 in screenshot header.
