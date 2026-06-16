# Debug Session: browser-viewport-dimensions
- **Status**: [OPEN]
- **Issue**: Log the actual CSS/post-scale dimensions the website renders at within the browser viewport
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-browser-viewport-dimensions.ndjson

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Webview/iframe CSS width/height equals viewportWidth × viewportHeight | High | Low | Pending |
| B | Content inside webview sees viewportWidth × viewportHeight as innerWidth/innerHeight | High | Low | Pending |
| C | viewportScale is correctly computed to fit the stage container | High | Low | Pending |
| D | Scaled frame outer dimensions (frame W×H) accommodate the full rendered content | Med | Low | Pending |
