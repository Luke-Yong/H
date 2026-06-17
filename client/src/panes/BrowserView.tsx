import { useRef, useCallback, useState, useEffect, useLayoutEffect } from "react";

interface BrowserTab {
  id: string;
  url: string;
  label: string;
}

interface Props {
  tabs: BrowserTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
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

interface ViewportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: "desktop-hd", label: "Laptop 1280 x 800", width: 1280, height: 800 },
  { id: "desktop-wide", label: "Desktop 1440 x 900", width: 1440, height: 900 },
  { id: "desktop-fullhd", label: "Full HD 1920 x 1080", width: 1920, height: 1080 },
  { id: "desktop-qhd", label: "QHD 2560 x 1440", width: 2560, height: 1440 },
  { id: "desktop-4k", label: "4K 3840 x 2160", width: 3840, height: 2160 },
  { id: "phone-iphone-17-pro-max", label: "iPhone 17 Pro Max 440 x 956", width: 440, height: 956 },
  { id: "phone-iphone-17-pro", label: "iPhone 17 Pro 402 x 874", width: 402, height: 874 },
  { id: "phone-iphone-16-pro-max", label: "iPhone 16 Pro Max 430 x 932", width: 430, height: 932 },
  { id: "phone-iphone-16-pro", label: "iPhone 16 Pro 393 x 852", width: 393, height: 852 },
  { id: "phone-iphone-16", label: "iPhone 16 390 x 844", width: 390, height: 844 },
  { id: "phone-s25-ultra", label: "Galaxy S25 Ultra 412 x 891", width: 412, height: 891 },
  { id: "phone-s25", label: "Galaxy S25 360 x 780", width: 360, height: 780 },
  { id: "phone-mate70-pro", label: "Mate 70 Pro 412 x 891", width: 412, height: 891 },
  { id: "fold-zfold6-cover", label: "Z Fold 6 Cover 323 x 792", width: 323, height: 792 },
  { id: "fold-zfold6-main", label: "Z Fold 6 Unfolded 720 x 619", width: 720, height: 619 },
  { id: "fold-zflip6", label: "Z Flip 6 393 x 960", width: 393, height: 960 },
  { id: "fold-matex6-cover", label: "Mate X6 Cover 412 x 915", width: 412, height: 915 },
  { id: "fold-matex6-main", label: "Mate X6 Unfolded 747 x 813", width: 747, height: 813 },
];

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

export default function BrowserView({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onTitleChange,
  onUrlChange,
  onNewTab,
}: Props) {
  const isDesktop = !!window.harnessDesktop?.isDesktop;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<BrowserGuest | null>(null);
  const webviewReadyRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
  const tabId = activeTab?.id || "";
  const url = activeTab?.url || "";
  const [navTabId, setNavTabId] = useState(tabId);
  const [navUrl, setNavUrl] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inputUrl, setInputUrl] = useState(url);
  const [secure, setSecure] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [viewportOpen, setViewportOpen] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1920);
  const [viewportHeight, setViewportHeight] = useState(1080);
  const [viewportPresetId, setViewportPresetId] = useState("desktop-fullhd");
  const [perms, setPerms] = useState<Permissions>({
    geolocation: false, camera: false, microphone: false, midi: false, autoplay: true,
  });
  const [viewportScale, setViewportScale] = useState(0.5);

  // Track actual iframe location (independently from prop, for same-origin nav)
  const liveUrlRef = useRef(url);

  // Sync the displayed URL when the prop changes (new tab, detected URL, etc.)
  useEffect(() => {
    // Keep the address bar in sync with parent state, but do not re-drive the
    // guest src for SPA route changes that originated inside the webview.
    setNavTabId(tabId);
    setNavUrl(url);
    setCurrentUrl(url);
    setInputUrl(url);
    setSecure(isHttps(url));
    liveUrlRef.current = url;
  }, [tabId, url]);

  const handleWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as BrowserGuest | null;
  }, []);



  const syncDesktopState = useCallback((reason: string) => {
    const view = webviewRef.current;
    if (!view || !tabId) return;
    if (!webviewReadyRef.current) return;

    let nextUrl = liveUrlRef.current;
    try {
      nextUrl = view.getURL?.() || liveUrlRef.current;
    } catch {
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
    if (!view) return;

    const onDidFinishLoad = () => syncDesktopState("did-finish-load");
    const onDidNavigate = () => syncDesktopState("did-navigate");
    const onDidNavigateInPage = () => syncDesktopState("did-navigate-in-page");
    const onPageTitleUpdated = () => syncDesktopState("page-title-updated");
    const handleNewWindow = (event: Event) => {
      const details = event as Event & {
        preventDefault?: () => void;
        url?: string;
        detail?: { url?: string };
      };
      const popupUrl = details.url || details.detail?.url || "";
      if (!popupUrl || popupUrl === "about:blank") return;
      details.preventDefault?.();
      onNewTab?.(popupUrl);
    };
    const handleDomReady = () => {
      webviewReadyRef.current = true;
      void view.executeJavaScript?.(`(()=>{var m=document.querySelector('meta[name="viewport"]');if(!m){m=document.createElement('meta');m.setAttribute('name','viewport');(document.head||document.documentElement).appendChild(m);}m.setAttribute('content','width=${viewportWidth},height=${viewportHeight},initial-scale=1');})()`, false).catch(()=>{});
      syncDesktopState("dom-ready");
    };
    const handleDidFailLoad = () => {};
    const handleIpcMessage = (event: Event) => {
      const details = event as Event & {
        channel?: string;
        args?: unknown[];
      };
      if (details.channel === "harness:browserOpenUrl") {
        const popupUrl = typeof details.args?.[0] === "string" ? details.args[0] : "";
        if (popupUrl && popupUrl !== "about:blank") {
          onNewTab?.(popupUrl);
        }
      }
    };

    view.addEventListener("dom-ready", handleDomReady);
    view.addEventListener("did-finish-load", onDidFinishLoad);
    view.addEventListener("did-navigate", onDidNavigate);
    view.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    view.addEventListener("page-title-updated", onPageTitleUpdated);
    view.addEventListener("new-window", handleNewWindow);
    view.addEventListener("did-fail-load", handleDidFailLoad);
    view.addEventListener("ipc-message", handleIpcMessage);

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
  }, [isDesktop, onNewTab, syncDesktopState, tabId, url, viewportWidth, viewportHeight]);

  // Re-inject viewport meta when preset changes
  useEffect(() => {
    if (!isDesktop) return;
    const view = webviewRef.current;
    if (!view || !webviewReadyRef.current) return;
    void view.executeJavaScript?.(`(()=>{var m=document.querySelector('meta[name="viewport"]');if(!m){m=document.createElement('meta');m.setAttribute('name','viewport');(document.head||document.documentElement).appendChild(m);}m.setAttribute('content','width=${viewportWidth},height=${viewportHeight},initial-scale=1');})()`, false).catch(()=>{});
  }, [isDesktop, viewportWidth, viewportHeight]);

  // Always scale the iframe to fit the container while keeping internal dimensions
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateScale = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scaleX = rect.width / viewportWidth;
      const scaleY = rect.height / viewportHeight;
      const s = Math.max(0.1, Math.min(scaleX, scaleY));
      setViewportScale(s);
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [viewportWidth, viewportHeight]);

  useEffect(() => {
    if (!isDesktop) return;
    const origin = getOrigin(currentUrl);
    if (!origin) return;
    void window.harnessDesktop?.setSitePermissions?.(origin, { ...perms }).catch(() => {});
  }, [currentUrl, isDesktop, perms]);

  // Called by the iframe's onLoad to read title/URL + patch window.open + _blank
  const handleIframeLoad = useCallback(() => {
    if (isDesktop) return;
    const iframe = iframeRef.current;
    if (!iframe || !tabId) return;
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        try {
          const head = doc.head || doc.documentElement;
          if (head) {
            let meta = doc.querySelector('meta[name="viewport"]');
            if (!meta) {
              meta = doc.createElement("meta");
              meta.setAttribute("name", "viewport");
              head.appendChild(meta);
            }
            meta.setAttribute("content", `width=${viewportWidth},height=${viewportHeight},initial-scale=1`);
          }
        } catch {}
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
  }, [isDesktop, onNewTab, onTitleChange, onUrlChange, tabId, viewportWidth, viewportHeight, viewportPresetId]);

  // Close dropdown when clicking the backdrop
  const closeOverlays = useCallback(() => {
    setStatusOpen(false);
    setViewportOpen(false);
  }, []);

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
    if (!tabId) return;
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
  }, [inputUrl, onUrlChange, tabId]);

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

  const setViewportPreset = useCallback((presetId: string) => {
    const preset = VIEWPORT_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setViewportPresetId(preset.id);
    setViewportWidth(preset.width);
    setViewportHeight(preset.height);
  }, []);

  const selectedPreset = VIEWPORT_PRESETS.find((p) => p.id === viewportPresetId) || VIEWPORT_PRESETS[0];

  const togglePerm = useCallback((key: keyof Permissions) => {
    setPerms((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const geolocationNeedsSecureContext = perms.geolocation && currentUrl && !supportsGeolocation(currentUrl);
  const desktopSrc = navTabId === tabId ? navUrl : url;

  return (
    <div className="browser-iframe-container">
      <div className="browser-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`browser-tab${tab.id === tabId ? " active" : ""}`}
            onClick={() => onSelectTab(tab.id)}
          >
            <span className="browser-tab-label">{tab.label || "New Tab"}</span>
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}>✕</span>
          </button>
        ))}
        <button className="browser-tab browser-tab-add" onClick={onAddTab} title="New browser tab">+</button>
      </div>
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
        <span className="browser-viewport-dims">{viewportWidth} x {viewportHeight}</span>
        <div className="browser-viewport-settings">
          <button
            className={`browser-btn${viewportOpen ? " active" : ""}`}
            onClick={() => {
              setViewportOpen((open) => !open);
              setStatusOpen(false);
            }}
            title="Viewport settings"
          >
            ⚙
          </button>
          {viewportOpen && (
            <div className="browser-viewport-dropdown">
              <div className="browser-status-section">
                <div className="browser-status-summary">Viewport</div>
                <div className="browser-status-url">{selectedPreset.label}</div>
              </div>
              <div className="browser-status-perms">
                <div className="browser-status-label">Preset</div>
                <select
                  className="browser-viewport-select"
                  value={viewportPresetId}
                  onChange={(e) => setViewportPreset(e.target.value)}
                >
                  <optgroup label="Desktop">
                    {VIEWPORT_PRESETS.filter((p) => p.id.startsWith("desktop-")).map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="iPhone">
                    {VIEWPORT_PRESETS.filter((p) => p.id.startsWith("phone-iphone-")).map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Samsung">
                    {VIEWPORT_PRESETS.filter((p) => p.id.startsWith("phone-s")).map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Huawei">
                    {VIEWPORT_PRESETS.filter((p) => p.id.startsWith("phone-mate")).map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Foldables">
                    {VIEWPORT_PRESETS.filter((p) => p.id.startsWith("fold-")).map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Backdrop: clicking anywhere outside the dropdown closes it */}
      {(statusOpen || viewportOpen) && <div className="browser-status-backdrop" onClick={closeOverlays} />}
      {!tabId ? (
        <div className="browser-placeholder">
          Open a browser tab to begin.
        </div>
      ) : currentUrl ? (
        <div
          ref={stageRef}
          className="browser-viewport-stage"
        >
          <div
            className="browser-viewport-wrapper"
            style={{
              width: `${Math.round(viewportWidth * viewportScale)}px`,
              height: `${Math.round(viewportHeight * viewportScale)}px`,
              overflow: "hidden",
            }}
          >
            <div
              className="browser-viewport-frame"
              style={{
                width: `${viewportWidth}px`,
                height: `${viewportHeight}px`,
                zoom: viewportScale,
              }}
            >
              {isDesktop ? (
                <webview
                  ref={handleWebviewRef}
                  key={tabId}
                  src={desktopSrc}
                  preload={window.harnessDesktop?.browserPreloadUrl}
                  partition="harness-browser"
                  allowpopups={true}
                  style={{ width: "100%", height: "100%" }}
                />
              ) : (
                <iframe
                  ref={iframeRef}
                  key={`${tabId}-${perms.geolocation}-${perms.camera}-${perms.microphone}`}
                  src={currentUrl}
                  allow={allowAttr}
                  sandbox={sandboxAttr}
                  onLoad={handleIframeLoad}
                  style={{ width: "100%", height: "100%", border: "none" }}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="browser-placeholder">
          Enter a URL or search query in the address bar above.
        </div>
      )}
    </div>
  );
}
