# Debug Session: bing-links-sandbox-sync

**Status:** [OPEN]
**Created:** 2026-06-17

## Symptoms
1. No localhost server → Bing: links clickable but new tabs blocked; title/secure-icon not updating
2. Localhost server active → Bing links open new tabs correctly (sandbox removed globally via proxy flag)
3. No localhost → direct URL entry: title + secure-icon not updating
4. No localhost → viewport toggle away from 1920×1080 temporarily fixes link behavior

## Hypotheses
- **H1 (Sandbox popup blocking):** `sandbox` attribute, even with `allow-popups-to-escape-sandbox`, prevents Bing from opening new tabs for `_blank` links. Removing sandbox fixes link behavior but title/URL sync requires a separate mechanism.
- **H2 (Cross-origin injection barrier):** The click interceptor in `injectIntoIframe` cannot access `contentDocument` for cross-origin pages (Bing), so `_blank` links fall through to native popup behavior which gets blocked. Proxy makes localhost same-origin, enabling injection.
- **H3 (Viewport render cycle):** Viewport dimension changes trigger conditions where injection succeeds transiently for cross-origin frames.
- **H4 (contentWindow timing gap):** `contentDocument` is briefly accessible during load before cross-origin enforcement, and viewport toggle creates a window for injection.
- **H5 (Bing JS compatibility):** Sandbox attribute combination prevents Bing's own JS from properly handling `window.open()`/`_blank` links, causing silent failures.

## Key Code Locations
- `client/src/panes/BrowserView.tsx` — iframe sandbox, injectIntoIframe, syncIframeState, click interceptor
- `electron/browser-preload.cjs` — desktop webview click interceptor (not used in iframe mode)
- `server/index.ts` — reverse proxy for localhost
