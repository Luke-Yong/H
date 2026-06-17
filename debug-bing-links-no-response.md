# Debug Session: bing-links-no-response
- **Status**: [OPEN]
- **Issue**: Bing search result links don't respond when clicked in browser iframe until a localhost app is loaded
- **Debug Server**: http://127.0.0.1:7778/event
- **Log File**: .dbg/trae-debug-log-bing-links-no-response.ndjson

## Reproduction Steps
1. Start Harness with no files/folders open
2. Open browser tab, search on Bing
3. Click any search result link → no response
4. Open project folder, run python app.py, localhost loads in new tab
5. Now Bing links in the original tab start working

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | iframe sandbox blocks Bing navigation (even with current flags) | High | Low | Pending |
| B | `iframeLoadHandler`/`injectIntoIframe` errors for cross-origin silently break navigation | Medium | Low | Pending |
| C | `src` prop or `toProxySrc` returns incorrect value causing iframe to lose loaded state | Low | Medium | Pending |
| D | React re-mounts the iframe (key change) when unrelated state updates | Medium | Low | Pending |
