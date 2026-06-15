import { useRef, useCallback, useState, useEffect } from "react";

interface Props {
  url: string;
  tabId: string;
  onTitleChange?: (tabId: string, title: string) => void;
  onUrlChange?: (tabId: string, url: string) => void;
  onNewTab?: (url: string) => void;
}

interface Permissions {
  geolocation: boolean;
  camera: boolean;
  microphone: boolean;
  midi: boolean;
  autoplay: boolean;
}

type BrowserGuest = HTMLElement & {
  src?: string;
  getURL?: () => string;
  getTitle?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  loadURL?: (url: string) => void;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

function isUrlLike(input: string): boolean {
  if (!input.trim()) return false;
  if (/^https?:\/\//i.test(input)) return true;
  if (/^localhost/i.test(input)) return true;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(input)) return true;
  if (/^\[.*\]/.test(input)) return true;
  if (input.includes(".") && !input.includes(" ")) return true;
  return false;
}

function isHttps(url: string): boolean {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

function getOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function supportsGeolocation(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function reportDebug(hypothesisId: string, location: string, msg: string, data: Record<string, unknown>) {
  // #region debug-point A:browser-report
  fetch("http://127.0.0.1:7777/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "desktop-browser-crash",
      runId: "post-fix",
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

export default function BrowserView({ url, tabId, onTitleChange, onUrlChange, onNewTab }: Props) {
  const isDesktop = !!window.harnessDesktop?.isDesktop;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<BrowserGuest | null>(null);
  const webviewReadyRef = useRef(false);
  const [navUrl, setNavUrl] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inputUrl, setInputUrl] = useState(url);
  const [secure, setSecure] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [perms, setPerms] = useState<Permissions>({
    geolocation: false, camera: false, microphone: false, midi: false, autoplay: true,
  });

  // Track actual iframe location (independently from prop, for same-origin nav)
  const liveUrlRef = useRef(url);

  // Sync the displayed URL when the prop changes (new tab, detected URL, etc.)
  useEffect(() => {
    // Keep the address bar in sync with parent state, but do not re-drive the
    // guest src for SPA route changes that originated inside the webview.
    setCurrentUrl(url);
    setInputUrl(url);
    setSecure(isHttps(url));
    liveUrlRef.current = url;
  }, [url]);

  const handleWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as BrowserGuest | null;
  }, []);

  const syncDesktopState = useCallback((reason: string) => {
    const view = webviewRef.current;
    // #region debug-point A:sync-enter
    reportDebug("A", "BrowserView.tsx:syncDesktopState", "enter syncDesktopState", {
      tabId,
      hasView: !!view,
      isDesktop,
      reason,
      liveUrl: liveUrlRef.current,
    });
    // #endregion
    if (!view) return;
    if (!webviewReadyRef.current) {
      // #region debug-point A:sync-skipped-not-ready
      reportDebug("A", "BrowserView.tsx:syncDesktopState", "skip syncDesktopState before dom-ready", {
        tabId,
        reason,
        liveUrl: liveUrlRef.current,
      });
      // #endregion
      return;
    }

    let nextUrl = liveUrlRef.current;
    try {
      nextUrl = view.getURL?.() || liveUrlRef.current;
    } catch (err) {
      // #region debug-point A:sync-get-url-error
      reportDebug("A", "BrowserView.tsx:syncDesktopState", "getURL threw", {
        tabId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      // #endregion
      return;
    }
    if (nextUrl && nextUrl !== "about:blank") {
      liveUrlRef.current = nextUrl;
      setCurrentUrl(nextUrl);
      setInputUrl(nextUrl);
      setSecure(isHttps(nextUrl));
      onUrlChange?.(tabId, nextUrl);
      if (reason !== "did-navigate-in-page") {
        setNavUrl(nextUrl);
      }
    }

    try {
      setCanGoBack(!!view.canGoBack?.());
      setCanGoForward(!!view.canGoForward?.());
    } catch {}
    try {
      const nextTitle = view.getTitle?.();
      if (nextTitle) {
        onTitleChange?.(tabId, nextTitle);
      }
    } catch {}
  }, [onTitleChange, onUrlChange, tabId, isDesktop]);

  useEffect(() => {
    if (!isDesktop) return;
    const view = webviewRef.current;
    webviewReadyRef.current = false;
    // #region debug-point A:effect-enter
    reportDebug("A", "BrowserView.tsx:desktopEffect", "desktop effect start", {
      tabId,
      hasView: !!view,
      url,
    });
    // #endregion
    if (!view) return;

    const onDidFinishLoad = () => syncDesktopState("did-finish-load");
    const onDidNavigate = () => syncDesktopState("did-navigate");
    const onDidNavigateInPage = () => syncDesktopState("did-navigate-in-page");
    const onPageTitleUpdated = () => syncDesktopState("page-title-updated");
    const handleNewWindow = (event: Event) => {
      const urlFromEvent =
        (event as Event & { url?: string }).url ||
        (event as Event & { detail?: { url?: string } }).detail?.url ||
        "";
      if (urlFromEvent && urlFromEvent !== "about:blank") {
        onNewTab?.(urlFromEvent);
      }
    };

    const handleDomReady = () => {
      webviewReadyRef.current = true;
      // #region debug-point A:dom-ready
      reportDebug("A", "BrowserView.tsx:dom-ready", "webview dom-ready", {
        tabId,
        url,
      });
      // #endregion
      syncDesktopState("dom-ready");
    };

    const handleDidFailLoad = (event: Event) => {
      const details = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
      };
      // #region debug-point D:did-fail-load
      reportDebug("D", "BrowserView.tsx:did-fail-load", "webview did-fail-load", {
        tabId,
        errorCode: details.errorCode,
        errorDescription: details.errorDescription,
        validatedURL: details.validatedURL,
      });
      // #endregion
    };

    const handleIpcMessage = (event: Event) => {
      const details = event as Event & {
        channel?: string;
        args?: unknown[];
      };
      if (details.channel !== "harness:browserPreloadDebug") return;
      const payload = (Array.isArray(details.args) ? details.args[0] : null) as
        | { msg?: string; data?: Record<string, unknown>; ts?: number }
        | null;
      // #region debug-point D:browser-preload-ipc
      reportDebug("D", "BrowserView.tsx:browserPreload", payload?.msg || "browser preload debug", {
        tabId,
        ...(payload?.data || {}),
      });
      // #endregion
    };

    view.addEventListener("dom-ready", handleDomReady);
    view.addEventListener("did-finish-load", onDidFinishLoad);
    view.addEventListener("did-navigate", onDidNavigate);
    view.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    view.addEventListener("page-title-updated", onPageTitleUpdated);
    view.addEventListener("new-window", handleNewWindow);
    view.addEventListener("did-fail-load", handleDidFailLoad);
    view.addEventListener("ipc-message", handleIpcMessage);

    // #region debug-point A:effect-await-dom-ready
    reportDebug("A", "BrowserView.tsx:desktopEffect", "awaiting dom-ready before sync", {
      tabId,
      url,
    });
    // #endregion

    return () => {
      webviewReadyRef.current = false;
      view.removeEventListener("dom-ready", handleDomReady);
      view.removeEventListener("did-finish-load", onDidFinishLoad);
      view.removeEventListener("did-navigate", onDidNavigate);
      view.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      view.removeEventListener("page-title-updated", onPageTitleUpdated);
      view.removeEventListener("new-window", handleNewWindow);
      view.removeEventListener("did-fail-load", handleDidFailLoad);
      view.removeEventListener("ipc-message", handleIpcMessage);
    };
  }, [isDesktop, onNewTab, syncDesktopState]);

  useEffect(() => {
    if (!isDesktop) return;
    const origin = getOrigin(currentUrl);
    if (!origin) return;
    // #region debug-point D:set-site-permissions
    reportDebug("D", "BrowserView.tsx:setSitePermissions", "push site permissions to desktop bridge", {
      origin,
      perms,
    });
    // #endregion
    void window.harnessDesktop?.setSitePermissions?.(origin, { ...perms }).then((ok) => {
      // #region debug-point D:set-site-permissions-result
      reportDebug("D", "BrowserView.tsx:setSitePermissions", "desktop bridge site permissions result", {
        origin,
        ok: !!ok,
      });
      // #endregion
    }).catch(() => {});
  }, [currentUrl, isDesktop, perms]);

  // Called by the iframe's onLoad to read title/URL + patch window.open + _blank
  const handleIframeLoad = useCallback(() => {
    if (isDesktop) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        const newUrl = doc.location?.href;
        if (newUrl && newUrl !== "about:blank" && newUrl !== liveUrlRef.current) {
          liveUrlRef.current = newUrl;
          setCurrentUrl(newUrl);
          setInputUrl(newUrl);
          setSecure(isHttps(newUrl));
          onUrlChange?.(tabId, newUrl);
        }
        const title = doc.title;
        if (title) onTitleChange?.(tabId, title);

        // Intercept window.open
        const win = iframe.contentWindow as any;
        if (win && !win.__harnessOpenPatched) {
          win.__harnessOpenPatched = true;
          const origOpen = win.open;
          win.open = (...args: any[]) => {
            const targetUrl = typeof args[0] === "string" ? args[0] : "";
            if (targetUrl && targetUrl !== "about:blank") {
              onNewTab?.(targetUrl);
              return null;
            }
            return origOpen ? origOpen.apply(win, args) : null;
          };
        }

        // Intercept target="_blank" (only once per document)
        if (!(doc as any).__harnessBlankPatched) {
          (doc as any).__harnessBlankPatched = true;
          doc.addEventListener("click", (e: MouseEvent) => {
            let el = e.target as HTMLElement | null;
            while (el) {
              if (el.tagName === "A" && el.getAttribute("target") === "_blank") {
                const href = el.getAttribute("href");
                if (href && !href.startsWith("javascript:")) {
                  e.preventDefault();
                  e.stopPropagation();
                  onNewTab?.(new URL(href, doc.baseURI).href);
                  return;
                }
              }
              el = el.parentElement;
            }
          }, true);
        }
      }
    } catch { /* cross-origin — silently ignored */ }
    setCanGoBack(true);
    setCanGoForward(true);
  }, [isDesktop, tabId, onTitleChange, onUrlChange, onNewTab]);

  // Close dropdown when clicking the backdrop
  const closeStatus = useCallback(() => setStatusOpen(false), []);

  // Build allow attribute from permissions
  const allowAttr = [
    "encrypted-media",
    "downloads",
    perms.geolocation && "geolocation",
    perms.camera && "camera",
    perms.microphone && "microphone",
    perms.midi && "midi",
    perms.autoplay && "autoplay",
  ].filter(Boolean).join("; ");

  const sandboxAttr = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-downloads-without-user-activation allow-modals allow-orientation-lock allow-pointer-lock allow-presentation allow-top-navigation-by-user-activation";

  const navigate = useCallback(() => {
    const raw = inputUrl.trim();
    if (!raw) return;
    let final: string;
    if (isUrlLike(raw)) {
      final = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    } else {
      final = `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
    }
    liveUrlRef.current = final;
    setNavUrl(final);
    setCurrentUrl(final);
    setInputUrl(final);
    setSecure(isHttps(final));
    onUrlChange?.(tabId, final);
  }, [inputUrl, isDesktop, tabId, onUrlChange]);

  const refresh = useCallback(() => {
    if (isDesktop) {
      webviewRef.current?.reload?.();
      return;
    }
    iframeRef.current?.contentWindow?.location.reload();
  }, [isDesktop]);

  const goBack = useCallback(() => {
    if (isDesktop) {
      if (webviewRef.current?.canGoBack?.()) webviewRef.current.goBack?.();
      return;
    }
    iframeRef.current?.contentWindow?.history.back();
  }, [isDesktop]);

  const goForward = useCallback(() => {
    if (isDesktop) {
      if (webviewRef.current?.canGoForward?.()) webviewRef.current.goForward?.();
      return;
    }
    iframeRef.current?.contentWindow?.history.forward();
  }, [isDesktop]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") navigate();
  }, [navigate]);

  const togglePerm = useCallback((key: keyof Permissions) => {
    setPerms((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // #region debug-point D:toggle-permission
      reportDebug("D", "BrowserView.tsx:togglePerm", "toggle site permission", {
        tabId,
        key,
        enabled: next[key],
        currentUrl,
      });
      // #endregion
      return next;
    });
  }, [currentUrl, isDesktop, tabId]);

  const geolocationNeedsSecureContext = perms.geolocation && currentUrl && !supportsGeolocation(currentUrl);

  return (
    <div className="browser-iframe-container">
      <div className="browser-toolbar">
        <button className="browser-btn" onClick={goBack} title="Back" disabled={isDesktop && !canGoBack}>◀</button>
        <button className="browser-btn" onClick={goForward} title="Forward" disabled={isDesktop && !canGoForward}>▶</button>
        <button className="browser-btn" onClick={refresh} title="Refresh">↻</button>
        <div className="browser-url-wrap">
          {currentUrl ? (
            <button
              className={`browser-secure-icon${secure ? " secure" : ""}`}
              onClick={() => setStatusOpen((o) => !o)}
              title="Site information"
            >
              {secure ? "🔒" : "⚠️"}
            </button>
          ) : (
            <span className="browser-secure-icon-placeholder" />
          )}
          <input
            className="browser-url-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search Bing or enter URL"
            spellCheck={false}
          />
          {statusOpen && currentUrl && (
            <div className="browser-status-dropdown">
              <div className="browser-status-section">
                <div className={`browser-status-summary${secure ? " secure" : ""}`}>
                  {secure ? "🔒 Connection is secure" : "⚠️ Connection is not secure"}
                </div>
                <div className="browser-status-url">{currentUrl}</div>
              </div>
              <div className="browser-status-perms">
                <div className="browser-status-label">Site permissions</div>
                {(["geolocation", "camera", "microphone", "midi", "autoplay"] as const).map((p) => (
                  <label key={p} className="browser-perm-row">
                    <span>{p.charAt(0).toUpperCase() + p.slice(1)}</span>
                    <input type="checkbox" checked={perms[p]} onChange={() => togglePerm(p)} />
                  </label>
                ))}
                {geolocationNeedsSecureContext && (
                  <div className="browser-status-note">
                    Location requires `https://` or localhost.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <button className="browser-btn browser-btn-go" onClick={navigate}>Go</button>
      </div>
      {/* Backdrop: clicking anywhere outside the dropdown closes it */}
      {statusOpen && <div className="browser-status-backdrop" onClick={closeStatus} />}
      {currentUrl ? (
        isDesktop ? (
          <webview
            ref={handleWebviewRef}
            key={tabId}
            className="browser-iframe"
            src={navUrl}
            preload={window.harnessDesktop?.browserPreloadUrl}
            partition="harness-browser"
            allowpopups={true}
          />
        ) : (
          <iframe
            ref={iframeRef}
            key={`${tabId}-${perms.geolocation}-${perms.camera}-${perms.microphone}`}
            className="browser-iframe"
            src={currentUrl}
            allow={allowAttr}
            sandbox={sandboxAttr}
            onLoad={handleIframeLoad}
          />
        )
      ) : (
        <div className="browser-placeholder">
          Enter a URL or search query in the address bar above.
        </div>
      )}
    </div>
  );
}
