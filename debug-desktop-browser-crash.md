# Debug Session: desktop-browser-crash

- Status: OPEN
- User symptom: Harness crashes after running `python app.py` and the browser tries to load the detected URL.
- Scope: Electron desktop mode, terminal URL detection, browser tab auto-open flow.

## Hypotheses

1. Auto-opening a detected localhost URL triggers a crash in the Electron browser surface (`webview`) lifecycle.
2. Electron main-process popup/navigation interception is causing the crash during initial page load.
3. React state changes from terminal URL detection are racing with terminal/browser rendering and causing a renderer crash.
4. Browser session or permission setup for the embedded browser crashes on first localhost navigation.
5. The Python process is not the cause; it only exposes the browser auto-open crash path.

## Evidence Log

- User-provided stack trace:
  - `Uncaught Error: The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.`
  - `at BrowserView.tsx:99`
  - `at handleSync (BrowserView.tsx:122)`
- Instrumentation added:
  - `App.tsx` URL-detection entry
  - `BrowserView.tsx` desktop effect entry
  - `BrowserView.tsx` immediate sync call
  - `BrowserView.tsx` sync entry
  - `BrowserView.tsx` `dom-ready` and `did-fail-load` events
- Pre-fix runtime evidence:
  - `App.tsx:handleDetectUrl` logged the localhost URL before crash.
  - `BrowserView.tsx:desktopEffect` logged `hasView: true`.
  - `BrowserView.tsx:syncDesktopState` ran immediately after effect start.
  - No `dom-ready` event was logged before the crash.

## Hypothesis Status

- A: Confirmed. `syncDesktopState()` ran before `dom-ready`, and `getURL()` threw on the unattached `webview`.
- B: Rejected. No evidence points to popup interception or main-process new-window handling.
- C: Partially involved but not root cause. React state update opened the tab, but the actual crash came from premature `webview` method access.
- D: Rejected for the remaining location issue. Electron now stores `geolocation` for `http://127.0.0.1:8000` and later logs `permission request ... allowed: true`.
- E: Confirmed. The Python app only exposed the browser auto-open path; it did not cause the crash directly.

## Post-Fix Evidence

- Crash path fixed:
  - `BrowserView.tsx:dom-ready` is now logged before stable sync activity.
  - No renderer crash occurred during browser auto-open.
- URL/path sync improved:
  - `liveUrl` updated to `http://127.0.0.1:8000/journey-planner`.
- Remaining location issue is outside Harness permission denial:
  - `electron/main.cjs:setSitePermissions` stored `["geolocation","autoplay"]`.
  - `electron/main.cjs:permissionRequest` later logged `permission: "geolocation", allowed: true`.
  - Therefore Harness/Electron granted permission, but the page still did not obtain location.
- Native Windows fallback added:
  - `electron/browser-preload.cjs` overrides `navigator.geolocation` inside desktop `webview`.
  - `electron/main.cjs` now serves `harness:getNativeLocation`.
  - `electron/native-location.cjs` queries Windows location via `System.Device.Location.GeoCoordinateWatcher`.
- Smoke test:
  - Direct helper invocation returned `{"ok":false,"code":3,"message":"Timed out waiting for Windows location."}`
  - This suggests the new Electron path is wired, but Windows location services may still be unavailable on the current machine.
- Latest evidence:
  - The guest preload and page-world patch now route page requests into `harness:getNativeLocation`.
  - A later run returned `ok: true, provider: "ip"` for `http://127.0.0.1:8000/mrt`.
  - New change: move from per-browser-call fetches to an IDE-wide shared location cache refreshed every minute, with reuse of the last good result.
  - User decision: switch Harness to `ip-only`, without Windows native location and without Chromium/Electron geolocation provider dependencies.

## Next Step

- Decide whether to investigate the loaded app / OS geolocation provider next, or stop with the Harness-side fix complete.
