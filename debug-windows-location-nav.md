[OPEN] Debug Session: windows-location-nav

## Summary
- Symptom: after browser navigation, site location access often works only after re-toggling the `Geolocation` permission checkbox.
- Goal: switch Harness to Windows OS location only, and make browser/site access depend on the shared location path rather than Chromium network geolocation.

## Hypotheses
- H1: the page requests `navigator.geolocation` before the page-world patch is active after navigation, so Chromium handles the first call and caches a failure.
- H2: the current `browser-preload` override does not consistently replace every post-navigation geolocation entry point, so some calls still bypass Harness.
- H3: site permission state is not re-applied early enough on navigation, causing the first post-navigation geolocation request to be denied until the checkbox is toggled again.
- H4: Windows OS location is currently returning a timeout or unavailable state on this machine, so even a correct bridge may fall back or appear broken.
- H5: the page’s own route loaders only retry after user interaction, so a successful Harness location result is not propagated into the screen state unless another trigger occurs.

## Evidence Plan
- Inspect current `native-location.cjs`, `browser-preload.cjs`, `main.cjs`, and `BrowserView.tsx` instrumentation points.
- Verify whether the existing debug server/log stream already captures the needed lifecycle for a Windows-only run.
- Add instrumentation only if a required observation point is missing.

## Status
- Session opened.
