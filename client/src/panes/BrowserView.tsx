import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo, forwardRef, useImperativeHandle } from "react";
import type { BrowserConsoleEntry } from "./TerminalPane";

interface BrowserTab {
  id: string;
  url: string;
  label: string;
}

export interface BrowserViewHandle {
  /** Run JS in the browser page and return the result (serialized). */
  evalInPage: (code: string) => Promise<string>;
  /** Type text into the input/textarea at screenshot-image coordinates x,y using realistic keyboard events. */
  typeIntoElement: (x: number, y: number, text: string) => Promise<string>;
  /** Get a short header for the current page: URL and title. */
  getScreenshotHeader: () => Promise<string>;
  /** Capture the visible page as a base64 PNG data URL (for vision-capable models) plus its pixel size. */
  captureScreenshotImage: () => Promise<{ url: string; imageW: number; imageH: number }>;
  /** Navigate to a URL in the current tab. */
  navigateTo: (url: string) => Promise<void>;
  /** Wait for an element matching a CSS selector to appear. Returns first match or empty. */
  waitForElement: (selector: string, timeoutMs?: number) => Promise<string>;
  /** Get captured console entries since page load (log/warn/error). */
  getConsoleEntries: () => Promise<string>;
  /** Get failed network requests (4xx/5xx/CORS errors). */
  getRequestErrors: () => Promise<string>;
  /** Get current browser tab URL and page load status. */
  getInfo: () => string;
  /** Select an option in the native <select> at screenshot-image coordinates x,y by value or label. */
  selectOption: (x: number, y: number, value?: string, label?: string) => Promise<string>;
  /** Clear the input/textarea at screenshot-image coordinates x,y. */
  clearElement: (x: number, y: number) => Promise<string>;
  /** Left-click at screenshot-image coordinates (scaled to the viewport). */
  clickCoords: (x: number, y: number) => Promise<string>;
  /** Move mouse to screenshot-image coordinates (triggers hover effects). */
  moveMouse: (x: number, y: number) => Promise<string>;
  /** Right-click at screenshot-image coordinates (opens context menu). */
  rightClick: (x: number, y: number) => Promise<string>;
  /** Scroll the page. */
  scrollPage: (x: number, y: number, to?: string) => Promise<string>;
  /** Press a keyboard key. */
  pressKey: (key: string) => Promise<string>;
  /** Upload files to a file input at screenshot-image coordinates x,y (or the page's first file input when x,y are null). */
  uploadFile: (x: number | null, y: number | null, paths: string[]) => Promise<string>;
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
  onConsoleEntry?: (tabId: string, entry: BrowserConsoleEntry) => void;
  onOpenDevtools?: () => void;
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
  /** Electron webview: numeric id usable with webContents.fromId in main. */
  getWebContentsId?: () => number;
};

// Injected into the guest page to resolve a click/type coordinate to the
// nearest interactive element (then snap to its center). This absorbs both the
// small coordinate errors a vision model makes AND CSS-zoom / meta-viewport /
// devicePixelRatio scaling between the screenshot and the page's layout space.
// `hResolveTarget` matches the click point against interactive elements'
// getBoundingClientRect boxes over a range of scale factors — getBoundingClientRect
// is the one coordinate space that stays consistent under CSS zoom, whereas
// elementFromPoint does not. `hElLabel` renders a short "<tag#id.cls> \"label\""
// description used in tool results so the agent can verify its click.
const PAGE_TARGET_HELPERS = `
const hResolveTarget = function(px, py, priorScale) {
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [contenteditable="true"], [tabindex], [onclick]';
  const rects = [];
  // Walk the document, piercing shadow roots and same-origin frames so
  // controls inside web components / iframes are reachable too. Elements
  // inside frames report viewport-relative rects, so we carry an offset.
  const collect = function(root, dx, dy) {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length && rects.length < 2000; i++) {
      const el = all[i];
      if (el.shadowRoot) collect(el.shadowRoot, dx, dy);
      if (el.contentDocument && el.contentDocument !== root && el.contentDocument !== document) {
        const fr = el.getBoundingClientRect();
        collect(el.contentDocument, dx + fr.left, dy + fr.top);
      }
      if (el.matches && el.matches(INTERACTIVE)) {
        const r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          rects.push({ el: el, left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy });
        }
      }
    }
  };
  collect(document, 0, 0);
  if (rects.length > 0) {
    // Screenshot pixel -> page layout pixel scale. Anchored at the ratio from
    // the captured image size / guest viewport, then widened to absorb zoom and
    // DPR differences. The true scale is where the click point falls on (or
    // nearest to) the intended element's rect.
    const base = (typeof priorScale === 'number' && priorScale > 0) ? priorScale : 1;
    let best = null, bestDist = Infinity, bestS = base;
    for (let k = -10; k <= 10; k++) {
      const S = base * Math.pow(2, k / 4);
      const mx = px * S, my = py * S;
      for (let j = 0; j < rects.length; j++) {
        const t = rects[j];
        const dx = mx < t.left ? t.left - mx : (mx > t.right ? mx - t.right : 0);
        const dy = my < t.top ? t.top - my : (my > t.bottom ? my - t.bottom : 0);
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = t; bestS = S; }
      }
    }
    if (best && bestDist <= 250 * 250) {
      return { el: best.el, via: 'nearest', hit: null, scale: bestS };
    }
  }
  const hit = document.elementFromPoint(px, py);
  return { el: hit || document.body, via: 'point', hit: hit, scale: 1 };
};
const hElLabel = function(el) {
  if (!el) return '<none>';
  const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
  const id = el.id ? '#' + el.id : '';
  let cls = '';
  if (el.className && typeof el.className === 'string') {
    const c = el.className.trim().split(' ').filter(Boolean).slice(0, 2).join('.');
    if (c) cls = '.' + c;
  }
  const raw = (el.value != null && String(el.value) !== '' ? String(el.value) : (el.textContent || ''));
  const txt = String(raw).trim().split(' ').filter(Boolean).join(' ').slice(0, 50);
  return '<' + tag + id + cls + '>' + (txt ? ' "' + txt + '"' : '');
};
// Renders a transient marker INSIDE the guest page at viewport coords x,y so it
// is guaranteed to be visible over the webview content (host-side overlays can
// be hidden behind the <webview> guest layer). kind: move | click | type |
// contextmenu. Auto-removes after a short pulse. Screenshots clear it first
// (see captureScreenshotImage) so markers never pollute vision-model input.
const hShowPointer = function(x, y, kind) {
  try {
    var el = window.__hPointerMarker;
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:26px;height:26px;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 4px rgba(0,0,0,0.25);';
      var dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;left:50%;top:50%;width:4px;height:4px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 4px rgba(0,0,0,0.9);';
      el.appendChild(dot);
      (document.body || document.documentElement).appendChild(el);
      window.__hPointerMarker = el;
      el.__hTimer = null;
    }
    if (kind === 'move') {
      el.style.width = '24px'; el.style.height = '24px';
      el.style.border = '2px solid rgba(225,37,27,0.9)';
      el.style.background = 'rgba(225,37,27,0.12)';
    } else if (kind === 'type') {
      el.style.width = '30px'; el.style.height = '30px';
      el.style.border = '2px solid rgba(174,133,45,0.95)';
      el.style.background = 'rgba(174,133,45,0.25)';
    } else if (kind === 'contextmenu') {
      el.style.width = '30px'; el.style.height = '30px';
      el.style.border = '2px dashed rgba(83,87,90,0.95)';
      el.style.background = 'rgba(83,87,90,0.18)';
    } else {
      el.style.width = '30px'; el.style.height = '30px';
      el.style.border = '2px solid rgba(225,37,27,0.95)';
      el.style.background = 'rgba(225,37,27,0.28)';
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    // Restart the pulse animation (force a reflow so it replays on repeat calls).
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'hPointerPulse ' + (kind === 'move' ? '0.9' : '1.5') + 's ease-out forwards';
    if (el.__hTimer) clearTimeout(el.__hTimer);
    el.__hTimer = setTimeout(function() {
      var m = window.__hPointerMarker;
      if (m && m.parentNode) m.parentNode.removeChild(m);
      window.__hPointerMarker = null;
    }, kind === 'move' ? 900 : 1500);
    if (!document.getElementById('h-pointer-keyframes')) {
      var st = document.createElement('style');
      st.id = 'h-pointer-keyframes';
      st.textContent = '@keyframes hPointerPulse{0%{opacity:1;transform:translate(-50%,-50%) scale(0.6)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.8)}}';
      (document.head || document.documentElement).appendChild(st);
    }
  } catch (e) {}
};
`;

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

export default forwardRef<BrowserViewHandle, Props>(function BrowserView({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onTitleChange,
  onUrlChange,
  onNewTab,
  onConsoleEntry,
  onOpenDevtools,
}: Props, ref) {
  const isDesktop = !!window.hDesktop?.isDesktop;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<BrowserGuest | null>(null);
  const webviewReadyRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  // Size of the last captured screenshot image plus the guest viewport size at
  // capture time — used to map screenshot-image coordinates to viewport coords.
  const lastCaptureRef = useRef<{ imageW: number; imageH: number; viewportW: number; viewportH: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputFocusedRef = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;

  // ── Browser reverse proxy (universal — all URLs proxied for same-origin iframe access) ──
  // Encodes a real URL into the server proxy URL format: /_browser?url=<encoded>
  const toProxySrc = useCallback((real: string): string => {
    if (!real) return real;
    return `/_browser?url=${encodeURIComponent(real)}`;
  }, []);

  // Absolute version for desktop webview (loadURL resolves relative to current page)
  const toProxySrcAbs = useCallback((real: string): string => {
    if (!real) return real;
    return `${window.location.origin}/_browser?url=${encodeURIComponent(real)}`;
  }, []);

  // Decodes a proxy URL back to the real URL for display
  const fromProxySrc = useCallback((proxy: string): string => {
    try {
      const u = new URL(proxy, window.location.origin);
      const encoded = u.searchParams.get("url");
      if (encoded) return decodeURIComponent(encoded);
    } catch {}
    return proxy;
  }, []);
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
    geolocation: true, camera: true, microphone: true, midi: true, autoplay: true,
  });
  const [viewportScale, setViewportScale] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  // Unified loading setter with a safety timeout: page background activity
  // (subframe/resource loads) can fire load-start events without a matching
  // main-frame finish, so this guarantees loading can never stay stuck on.
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setLoadingState = useCallback((value: boolean) => {
    if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
    setLoading(value);
    if (value) {
      loadingTimerRef.current = setTimeout(() => { loadingTimerRef.current = null; setLoading(false); }, 10000);
    }
  }, []);
  useEffect(() => () => { if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current); }, []);
  const consoleSeqRef = useRef(0);
  const onConsoleEntryRef = useRef(onConsoleEntry);
  onConsoleEntryRef.current = onConsoleEntry;
  const [inspectMode, setInspectMode] = useState(false);
  const injectInspectorRef = useRef<((iframe: HTMLIFrameElement) => void) | null>(null);

  // Track actual iframe location (independently from prop, for same-origin nav)
  const liveUrlRef = useRef(url);

  // ── Iframe browser state sync (mirrors desktop syncDesktopState pattern) ──
  // Unified sync for URL, title, and navigation state — used by polling, load events, and history hooks
  const syncIframeState = useCallback(() => {
    const ifr = iframeRef.current;
    if (!ifr || !tabId) return;

    let cdAccessible = false;
    try { cdAccessible = !!ifr.contentDocument; } catch {}
    if (!cdAccessible) return;

    // getURL – read current href from iframe's contentDocument (now same-origin via proxy)
    let nextUrl: string | undefined;
    try {
      const raw = ifr.contentDocument?.location?.href;
      if (raw) nextUrl = fromProxySrc(raw);
    } catch {
      return;
    }
    if (!nextUrl || nextUrl === "about:blank") return;

    if (nextUrl !== liveUrlRef.current) {
      liveUrlRef.current = nextUrl;
      setCurrentUrl(nextUrl);
      setInputUrl(nextUrl);
      setSecure(isHttps(nextUrl));
      onUrlChange?.(tabId, nextUrl);
    }

    // getTitle
    try {
      const t = ifr.contentDocument?.title;
      if (t) onTitleChange?.(tabId, t);
    } catch {}

    // canGoBack / canGoForward
    try {
      setCanGoBack((ifr.contentWindow?.history?.length ?? 0) > 1);
    } catch {}
  }, [tabId, onUrlChange, onTitleChange]);

  // Ref-based accessor for history hooks to avoid stale closures
  const syncIframeStateRef = useRef(syncIframeState);
  syncIframeStateRef.current = syncIframeState;

  // Sync inputUrl whenever the actual URL changes, unless the user is actively editing
  useEffect(() => {
    if (!inputFocusedRef.current) {
      setInputUrl(currentUrl);
    }
  }, [currentUrl]);

  // Sync the displayed URL when the prop changes (new tab, detected URL, etc.)
  // IMPORTANT: when urlSyncFromWebviewRef is true, the URL change originated from the
  // webview itself (redirect / in-page navigation). We must NOT update navUrl or
  // navTabId — changing the <webview> src attribute would trigger a reload loop.
  useEffect(() => {
    if (urlSyncFromWebviewRef.current) {
      urlSyncFromWebviewRef.current = false;
      setCurrentUrl(url);
      setInputUrl(url);
      setSecure(isHttps(url));
      liveUrlRef.current = url;
      setPageError(null);
      if (url) setLoadingState(true);
    } else {
      setNavTabId(tabId);
      setNavUrl(url);
      setCurrentUrl(url);
      setInputUrl(url);
      setSecure(isHttps(url));
      liveUrlRef.current = url;
      setPageError(null);
      if (url) setLoadingState(true);
    }

    if (!url) {
      requestAnimationFrame(() => { inputRef.current?.focus(); });
    }
  }, [tabId, url, isDesktop]);

  const handleWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as BrowserGuest | null;
    if (node) {
      node.setAttribute("allowpopups", "");
    }
  }, []);

  // Track user-initiated navigation to prevent polling from reverting URL
  const navigatingRef = useRef(false);

  // Track whether a URL update in props was triggered by the webview itself
  // (e.g. a server redirect). When true, we must NOT update navUrl — doing so
  // would change the <webview> src attribute and trigger a reload, causing
  // a redirect feedback loop.
  const urlSyncFromWebviewRef = useRef(false);

  // Set up iframe load listener + polling (native events, not React synthetic)
  const setupIframe = useCallback((iframe: HTMLIFrameElement | null) => {
    // Clean up previous iframe's poll/listener so a stale-tabId sync never runs
    const prev = iframeRef.current;
    if (prev && (prev as any).__hc) {
      (prev as any).__hc();
    }
    if (prev && (prev as any).__htreeCleanup) {
      (prev as any).__htreeCleanup();
    }
    (iframeRef as any).current = iframe;
    if (!iframe) return;
    iframe.addEventListener("load", syncIframeState);
    // Poll: sync URL/title + attempt early injection (before load event fires)
    // injectIntoIframe has __hPatched guard so repeated calls are safe
    const poll = setInterval(() => {
      syncIframeState();
      try { if (iframe.contentDocument?.body) injectIntoIframeRef.current?.(iframe); } catch {}
    }, 300);
    if (iframe.contentDocument) {
      try { syncIframeState(); } catch {}
    }
    (iframe as any).__hc = () => {
      iframe.removeEventListener("load", syncIframeState);
      clearInterval(poll);
    };
  }, [syncIframeState]);

  // Inject viewport meta + history hooks into the iframe on every load
  const injectIntoIframe = useCallback((iframe: HTMLIFrameElement) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      // viewport meta
      const head = doc.head || doc.documentElement;
      if (head) {
        let meta: HTMLMetaElement | null = doc.querySelector('meta[name="viewport"]');
        if (!meta) { meta = doc.createElement("meta"); meta.setAttribute("name","viewport"); head.appendChild(meta); }
        meta.setAttribute("content", `width=${viewportWidth},height=${viewportHeight},initial-scale=1`);
      }
      // Layer 4: intercept pushState / replaceState
      // Layer 1: popstate / hashchange native events
      // Layer 3: click capture — detect <a> navigation
      const win = iframe.contentWindow as any;
      if (!win) return;
      if (!win.__hPatched) {
        win.__hPatched = true;
        const patch = (orig: Function) => function(this: any, ...args: any[]) {
          orig.apply(this, args as any);
          syncIframeStateRef.current();
        };
        win.history.pushState = patch(win.history.pushState);
        win.history.replaceState = patch(win.history.replaceState);
        win.addEventListener("popstate", syncIframeStateRef.current);
        win.addEventListener("hashchange", syncIframeStateRef.current);
        // Intercept window.open — redirect to new browser tab instead of popup
        const origOpen = win.open;
        win.open = function(url?: string, target?: string) {
          if (url && url !== "about:blank") {
            onNewTabRef.current?.(url);
          }
          return origOpen.call(win, "about:blank", target);
        };
        doc.addEventListener("click", (e: MouseEvent) => {
          const a = (e.target as Element).closest("a");
          if (a && (a as HTMLAnchorElement).href) {
            const href = (a as HTMLAnchorElement).href;
            const target = (a as HTMLAnchorElement).target;
            // target="_blank" or target="_new" → open in new browser tab
            if (target === "_blank" || target === "_new") {
              e.preventDefault();
              e.stopPropagation();
              onNewTabRef.current?.(href);
              return;
            }
            // Same-origin same-tab link -> let browser handle, sync URL bar
            if (!target && (a as HTMLAnchorElement).origin === win.location.origin) {
              syncIframeStateRef.current();
              return;
            }
            // Cross-origin same-tab link → route through proxy (so DOM tree stays accessible)
            if (!target) {
              e.preventDefault();
              e.stopPropagation();
              onUrlChangeRef.current?.(tabIdRef.current, href);
            }
          }
        }, true);

        // Console capture — intercept console.log/warn/error/info and post to parent
        if (!win.__hConsolePatched) {
          win.__hConsolePatched = true;
          win.__hConsoleEntries = [];

          // Robust object serializer for console output (injected into iframe)
      const serialize = function(v: unknown, depth: number, seen: WeakSet<object>): string {
        if (depth > 4) return "[MaxDepth]";
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        const t = typeof v;
        if (t === "string") return v as string;
        if (t === "number" || t === "boolean" || t === "bigint" || t === "symbol") return String(v);
        if (t === "function") return "[Function: " + ((v as Function).name || "anonymous") + "]";
        if (v instanceof Error) return v.toString();
        if (v instanceof (win.Element || Element)) {
          const el = v as Element;
          const id = el.id ? "#" + el.id : "";
          return "<" + el.tagName.toLowerCase() + id + ">";
        }
        if (v instanceof (win.Window || Window)) return "[Window]";
        if (v instanceof (win.Document || Document)) return "[Document]";
        if (typeof v !== "object") return String(v);

        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);

        if (Array.isArray(v)) {
          const items = (v as unknown[]).map(function(item: unknown) {
            return serialize(item, depth + 1, seen);
          });
          seen.delete(v as object);
          if (items.join(", ").length > 500) return "[Array(" + (v as unknown[]).length + ")]";
          return "[" + items.join(", ") + "]";
        }

        if (v instanceof (win.Node || Node)) {
          const el = v as Element;
          seen.delete(v as object);
          return "<" + (el.tagName || el.nodeName || "node").toLowerCase() + ">";
        }

        try {
          const keys = Object.keys(v);
          if (keys.length === 0) { seen.delete(v as object); return "{}"; }
          const pairs = keys.slice(0, 20).map(function(k: string) {
            return k + ": " + serialize((v as any)[k], depth + 1, seen);
          });
          seen.delete(v as object);
          const suffix = keys.length > 20 ? ", ...+" + (keys.length - 20) : "";
          return "{" + pairs.join(", ") + suffix + "}";
        } catch {
          seen.delete(v as object);
          return String(v);
        }
      };

      const fmt = function(args: unknown[]): string {
        const seen = new WeakSet<object>();
        return Array.prototype.map.call(args, function(a: unknown) { return serialize(a, 0, seen); }).join(" ");
      };

      const postEntry = function(level: string, text: string) {
        win.__hConsoleEntries.push({ level, text, time: Date.now() });
        if (win.__hConsoleEntries.length > 500) win.__hConsoleEntries.shift();
        if (text.length > 2000) {
          let remaining = text, chunk = 0;
          while (remaining) {
            window.postMessage({ __h: true, type: "console", level: level, text: remaining.substring(0, 2000), time: Date.now() }, "*");
            remaining = remaining.substring(2000); chunk++;
            if (chunk > 5) { window.postMessage({ __h: true, type: "console", level: level, text: "...[truncated]", time: Date.now() }, "*"); break; }
          }
        } else {
          window.postMessage({ __h: true, type: "console", level: level, text: text, time: Date.now() }, "*");
        }
      };

      const methods: Array<{ method: string; level: string }> = [
        { method: "log", level: "log" }, { method: "info", level: "info" },
        { method: "warn", level: "warn" }, { method: "error", level: "error" },
        { method: "debug", level: "log" },
      ];
      methods.forEach(function(cfg) {
        const orig = win.console[cfg.method] as (...args: unknown[]) => void;
        win.console[cfg.method] = function(...args: unknown[]) {
          orig.apply(win.console, args);
          try { postEntry(cfg.level, fmt(args)); } catch { /* ignore */ }
        };
      });

          // Capture unhandled errors
          const origOnerror = win.onerror;
          win.onerror = function (msg: string, source?: string, line?: number, col?: number) {
            window.postMessage({
              __h: true,
              type: "console",
              level: "error",
              text: `${msg}${source ? ` (${source}:${line}:${col})` : ""}`,
              source: source ? `${source}:${line}:${col}` : undefined,
              time: Date.now(),
            }, "*");
            if (origOnerror) origOnerror.call(win, msg, source, line, col);
          };

          // Intercept alert/confirm/prompt — block on a server long-poll so the
          // browser sub-agent can answer them via browser_respond_dialog.
          // The page freezes until answered (exactly like a real modal), and
          // auto-dismisses after 2 minutes so it can never hang forever.
          win.__hDialogAwait = function(type: string, message: string, defaultValue: string): { answered: boolean; value: string } {
            const id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            const start = Date.now();
            const budget = 120000;
            const origin = (win.location && win.location.origin) || "";
            while (Date.now() - start < budget) {
              let xhr: XMLHttpRequest;
              try { xhr = new win.XMLHttpRequest(); } catch { break; }
              try {
                xhr.open("POST", origin + "/_h-dialog/await", false);
                xhr.setRequestHeader("Content-Type", "application/json");
                xhr.send(JSON.stringify({ id, type, message: String(message), defaultValue: String(defaultValue || "") }));
              } catch { break; }
              if (xhr.status === 200) {
                try {
                  const r = JSON.parse(xhr.responseText);
                  if (r && r.status === "answered") return { answered: true, value: String(r.value ?? "") };
                  if (r && r.status === "gone") break;
                } catch { break; }
              } else { break; }
            }
            return { answered: false, value: "" };
          };
          win.alert = function(msg: any) {
            postEntry("dialog", "[ALERT] " + String(msg));
            win.__hDialogAwait("alert", String(msg), "");
          };
          win.confirm = function(msg: any) {
            postEntry("dialog", "[CONFIRM] " + String(msg));
            const r = win.__hDialogAwait("confirm", String(msg), "");
            return r.answered ? r.value === "true" : false;
          };
          win.prompt = function(msg: any, def?: string) {
            postEntry("dialog", "[PROMPT] " + String(msg) + (def ? " (default: " + def + ")" : ""));
            const r = win.__hDialogAwait("prompt", String(msg), def || "");
            return r.answered ? r.value : (def || "");
          };

          // PerformanceObserver: capture failed network requests (4xx/5xx/CORS)
          win.__hRequestErrors = [];
          try {
            const obs = new (win.PerformanceObserver)((list: any) => {
              for (const entry of list.getEntries()) {
                const e = entry as any;
                if (e.responseStatus && (e.responseStatus >= 400 || e.responseStatus === 0)) {
                  win.__hRequestErrors.push({
                    url: e.name,
                    method: 'fetch',
                    status: e.responseStatus,
                    type: e.initiatorType,
                    time: Date.now(),
                  });
                  if (win.__hRequestErrors.length > 200) win.__hRequestErrors.shift();
                }
              }
            });
            obs.observe({ type: 'resource', buffered: true });
          } catch (_) { /* PerformanceObserver not supported */ }

          // Also intercept fetch/XHR for status codes that PerformanceObserver may miss
          const origFetch = win.fetch;
          win.fetch = function(...args: any[]) {
            return origFetch.apply(win, args).then(function(r: Response) {
              if (!r.ok) {
                win.__hRequestErrors.push({
                  url: typeof args[0] === 'string' ? args[0] : (args[0].url || 'unknown'),
                  method: (args[0].method || 'GET').toUpperCase(),
                  status: r.status,
                  type: 'fetch',
                  time: Date.now(),
                });
                if (win.__hRequestErrors.length > 200) win.__hRequestErrors.shift();
              }
              return r;
            }, function(err: any) {
              win.__hRequestErrors.push({
                url: typeof args[0] === 'string' ? args[0] : (args[0]?.url || 'unknown'),
                method: (args[0]?.method || 'GET').toUpperCase(),
                status: 0,
                type: 'fetch-error',
                time: Date.now(),
              });
              if (win.__hRequestErrors.length > 200) win.__hRequestErrors.shift();
              throw err;
            }) as any;
          };
        }
      }

      // DOM tree: immediate send + persistent debounced MutationObserver
      const walkAndSendTree = () => {
        try {
          const d = (iframe as HTMLIFrameElement).contentDocument;
          if (!d || !d.body || d.body.children.length === 0) return;
          const nodes: Array<{ uid: string; tag: string; id: string; classes: string; text: string; attrs: string }> = [];
          let seq = 0;
          const walk = (el: Element | null, prefix: string) => {
            if (!el) return;
            let idx = 0;
            for (const child of Array.from(el.children)) {
              const uid = prefix ? prefix + "." + idx : String(idx);
              const tag = child.tagName.toLowerCase();
              const childId = child.id ? "#" + child.id : "";
              const cls = child.className && typeof child.className === "string"
                ? "." + child.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
              const txt = (child.textContent || "").trim().substring(0, 60);
              let attrs = "";
              if (child.attributes) {
                for (let i = 0; i < child.attributes.length; i++) {
                  const a = child.attributes[i];
                  if (a.name !== "class" && a.name !== "id" && a.name !== "style") {
                    attrs += " " + a.name + (a.value ? "=\"" + a.value + "\"" : "");
                  }
                }
              }
              nodes.push({ uid, tag, id: childId, classes: cls, text: txt, attrs });
              try { child.setAttribute("data-__huid", uid); } catch {}
              if (seq++ < 2000 && child.children.length > 0 && uid.split(".").length < 6) walk(child, uid);
              idx++;
            }
          };
          walk(d.body, "");
          window.postMessage({ __h: true, type: "domTree", nodes }, "*");
          const w = (iframe as HTMLIFrameElement).contentWindow as any;
          if (w && !w.__hHighlight) {
            w.__hHighlight = (targetUid: string) => {
              try {
                const el = d.querySelector('[data-__huid="' + targetUid.replace(/"/g, '\\"') + '"]');
                if (el) {
                  (el as HTMLElement).style.outline = "2px solid #4ec94e";
                  (el as HTMLElement).style.outlineOffset = "-1px";
                  el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
                  setTimeout(() => { try { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } catch {} }, 2000);
                }
              } catch {}
            };
          }
        } catch {}
      };

      // Send immediately
      walkAndSendTree();

      // Persistent MutationObserver — debounced to avoid flooding on rapid DOM changes
      let moTimer: ReturnType<typeof setTimeout> | null = null;
      let mo: MutationObserver | null = null;
      try {
        const d = (iframe as HTMLIFrameElement).contentDocument;
        if (d && d.body) {
          mo = new MutationObserver(() => {
            if (moTimer) clearTimeout(moTimer);
            moTimer = setTimeout(walkAndSendTree, 150);
          });
          mo.observe(d.body, { childList: true, subtree: true });
        }
      } catch {}
      (iframe as any).__htreeCleanup = () => {
        if (moTimer) clearTimeout(moTimer);
        if (mo) mo.disconnect();
      };

      syncIframeStateRef.current();
    } catch { /* cross-origin or other error */ }
  }, [viewportWidth, viewportHeight]);

  // On every iframe load (React synthetic), inject hooks
  const iframeLoadHandler = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    setLoadingState(false);
    setPageError(null);
    injectIntoIframe(e.currentTarget);
    // Detect JSON responses in iframe
    try {
      const doc = e.currentTarget.contentDocument;
      if (doc && doc.body) {
        const text = (doc.body.textContent || "").trim();
        // Check if body is just JSON (either raw or browser-wrapped in <pre>)
        const isJsonBody = doc.body.children.length === 0
          || (doc.body.children.length === 1 && doc.body.children[0]?.tagName === "PRE");
        if (isJsonBody && (text.startsWith("{") || text.startsWith("["))) {
          try {
            const parsed = JSON.parse(text);
            const formatted = JSON.stringify(parsed, null, 2);
            doc.body.innerHTML = '<pre style="font:12px monospace;padding:12px;white-space:pre-wrap;color:#ccc;background:#1a1a1a;margin:0;min-height:100vh;">' + formatted.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
          } catch {}
        }
      }
    } catch {}
  }, [injectIntoIframe, tabId, currentUrl]);

  // Ref for early injection from polling (defined after injectIntoIframe)
  const injectIntoIframeRef = useRef(injectIntoIframe);
  injectIntoIframeRef.current = injectIntoIframe;

  // Cleanup when iframe detaches
  useEffect(() => {
    return () => {
      const ifr = iframeRef.current;
      if (ifr && (ifr as any).__hc) (ifr as any).__hc();
    };
  }, []);

  // Listen for console/element messages from iframe (only from active tab)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || !e.data.__h) return;
      // Only accept messages from the active tab's iframe or from our own window
      if (!isDesktop && e.data.type !== "requestRefresh" && e.data.type !== "toggle-inspect" && e.data.type !== "highlight" && e.data.type !== "domTree") {
        const activeWin = iframeRef.current?.contentWindow;
        if (e.source !== window && (!activeWin || e.source !== activeWin)) return;
      }
      if (e.data.type === "console") {
        const entry: BrowserConsoleEntry = {
          id: `browser-${Date.now()}-${++consoleSeqRef.current}`,
          level: e.data.level,
          text: e.data.text,
          time: e.data.time || Date.now(),
          source: e.data.source,
        };
        onConsoleEntryRef.current?.(tabIdRef.current, entry);
      } else if (e.data.type === "domTree") {
        window.postMessage({ __hDevtools: true, type: "domTree", nodes: e.data.nodes }, "*");
      } else if (e.data.type === "hoverNode") {
        window.postMessage({ __hDevtools: true, type: "hoverNode", uid: e.data.uid }, "*");
      } else if (e.data.type === "inspectNode") {
        window.postMessage({ __hDevtools: true, type: "inspectNode", uid: e.data.uid }, "*");
      } else if (e.data.type === "highlight") {
        if (isDesktop) {
          const view = webviewRef.current;
          if (view) {
            void view.executeJavaScript?.("window.__hHighlight?.('"+String(e.data.uid).replace(/'/g,"\\'")+"')", false).catch(() => {});
          }
        } else if (iframeRef.current?.contentWindow) {
          (iframeRef.current.contentWindow as any).__hHighlight?.(e.data.uid);
        }
      } else if (e.data.type === "toggle-inspect") {
        setInspectMode(!!e.data.active);
        // Sync inspect state to TerminalPane
        window.postMessage({ __hDevtools: true, type: "inspectState", active: !!e.data.active }, "*");
        if (isDesktop) {
          const view = webviewRef.current;
          if (view) {
            if (e.data.active) {
              void view.executeJavaScript?.(`
                window.__hInspectorActive=true;
                (function(){
                  var s=document.createElement('style');s.id='__h_inspect_style';
                  s.textContent='*{cursor:default!important}a,button,input,select,textarea,[onclick]{pointer-events:auto!important}';
                  document.head.appendChild(s);
                  function block(ev){if(window.__hInspectorActive){ev.preventDefault();ev.stopPropagation()}}
                  ['mousedown','mouseup','keydown','keypress','submit','focus','auxclick','dblclick','contextmenu'].forEach(function(n){document.addEventListener(n,block,true)});
                  window.__hInspectBlocker=block;
                })()
              `, false).catch(() => {});
            } else {
              void view.executeJavaScript?.(`
                window.__hInspectorActive=false;
                var l=window.__hLastEl;if(l&&l.style){l.style.outline=''}window.__hLastEl=null;
                var ib=document.getElementById('__h_inspector_info');if(ib)ib.style.display='none';
                var ss=document.getElementById('__h_inspect_style');if(ss)ss.remove();
                if(window.__hInspectBlocker){
                  var b=window.__hInspectBlocker;
                  ['mousedown','mouseup','keydown','keypress','submit','focus','auxclick','dblclick','contextmenu'].forEach(function(n){document.removeEventListener(n,b,true)});
                  delete window.__hInspectBlocker;
                }
              `, false).catch(() => {});
              window.postMessage({ __hDevtools: true, type: "inspectEnd" }, "*");
            }
          }
        } else if (iframeRef.current?.contentWindow) {
          if (e.data.active) {
            injectInspectorRef.current?.(iframeRef.current);
          } else {
            (iframeRef.current.contentWindow as any).__hInspectorCleanup?.();
            window.postMessage({ __hDevtools: true, type: "inspectEnd" }, "*");
          }
        }
        if (!e.data.active) {
          window.postMessage({ __hDevtools: true, type: "inspectEnd" }, "*");
        }
      } else if (e.data.type === "requestRefresh") {
        // TerminalPane just opened — re-send DOM tree
        if (isDesktop) {
          void readDesktopDomTree();
        } else {
          // iframe: walk DOM immediately
          try {
            const d = iframeRef.current?.contentDocument;
            if (d?.body && d.body.children.length > 0) {
              const nodes: Array<{ uid: string; tag: string; id: string; classes: string; text: string; attrs: string }> = [];
              let seq = 0;
              const walk = (el: Element | null, prefix: string) => {
                if (!el) return;
                let idx = 0;
                for (const child of Array.from(el.children)) {
                  const uid = prefix ? prefix + "." + idx : String(idx);
                  try { child.setAttribute("data-__huid", uid); } catch {}
                  nodes.push({ uid, tag: child.tagName.toLowerCase(), id: child.id ? "#" + child.id : "", classes: child.className && typeof child.className === "string" ? "." + child.className.trim().split(/\s+/).filter(Boolean).join(".") : "", text: (child.textContent || "").trim().substring(0, 60), attrs: "" });
                  if (seq++ < 2000 && child.children.length > 0 && uid.split(".").length < 6) walk(child, uid);
                  idx++;
                }
              };
              walk(d.body, "");
              window.postMessage({ __h: true, type: "domTree", nodes }, "*");
            }
          } catch {}
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onConsoleEntry]);

  // Immediate DOM tree update on browser tab switch (console is per-tab in EditorPane)
  useEffect(() => {
    // Deactivate inspect mode when switching tabs
    if (inspectMode) {
      window.postMessage({ __h: true, type: "toggle-inspect", active: false }, "*");
    }
    // Clear old tab's DOM tree from TerminalPane immediately
    window.postMessage({ __hDevtools: true, type: "domTree", nodes: [] }, "*");
    // Immediately request fresh tree for the new tab
    window.postMessage({ __h: true, type: "requestRefresh" }, "*");
  }, [tabId]);

  const syncDesktopState = useCallback((reason: string) => {
    const view = webviewRef.current;
    if (!view || !tabId) return;

    let nextUrl = liveUrlRef.current;
    try {
      nextUrl = fromProxySrc(view.getURL?.() || "") || liveUrlRef.current;
    } catch {
      return;
    }
    if (!nextUrl || nextUrl === "about:blank") return;

    if (nextUrl !== liveUrlRef.current) {
        // During user-initiated navigation, the webview still shows the old URL.
        // Block ALL sync sources until the navigation completes (did-navigate/did-finish-load
        // reset the flag before calling us).
        if (navigatingRef.current) return;

        liveUrlRef.current = nextUrl;
        setCurrentUrl(nextUrl);
        setInputUrl(nextUrl);
        setSecure(isHttps(nextUrl));
        // Flag that this URL change originated from the webview (redirect / in-page nav).
        // The parent state update will flow back as a new `url` prop, but we must NOT
        // update navUrl in the effect below — that would change webview src and cause
        // a reload loop.
        urlSyncFromWebviewRef.current = true;
        onUrlChange?.(tabId, nextUrl);
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

  // Viewport meta + DOM change signal + inspect handlers for desktop webview
  // Console capture is NOT injected — we use the native `console-message` webview event instead.
  // DOM tree is NOT serialized here — we read it directly via executeJavaScript return value.
  const DESKTOP_INJECT_CODE = useMemo(() => String.raw`
    (()=>{
      var m=document.querySelector('meta[name="viewport"]');
      if(!m){m=document.createElement('meta');m.setAttribute('name','viewport');(document.head||document.documentElement).appendChild(m);}
      m.setAttribute('content','width=${viewportWidth},height=${viewportHeight},initial-scale=1');
      if(window.__hPatched)return;window.__hPatched=true;
      // Intercept alert/confirm/prompt — block on a server long-poll so the
      // browser sub-agent can answer them via browser_respond_dialog. The page
      // freezes until answered, and auto-dismisses after 2 minutes.
      window.__hDialogAwait=function(type,message,defaultValue){
        var id='d'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
        var start=Date.now();var budget=120000;
        var origin=(window.location&&window.location.origin)||'';
        while(Date.now()-start<budget){
          var xhr=null;
          try{xhr=new XMLHttpRequest()}catch(e){break}
          try{xhr.open('POST',origin+'/_h-dialog/await',false);xhr.setRequestHeader('Content-Type','application/json');xhr.send(JSON.stringify({id:id,type:type,message:String(message),defaultValue:String(defaultValue||'')}))}catch(e){break}
          if(xhr.status===200){
            try{var r=JSON.parse(xhr.responseText);if(r&&r.status==='answered')return{answered:true,value:String(r.value||'')};if(r&&r.status==='gone')break}catch(e){break}
          }else{break}
        }
        return{answered:false,value:''};
      };
      window.alert=function(msg){
        console.log('[DIALOG] [ALERT] '+String(msg));
        window.__hDialogAwait('alert',String(msg),'');
      };
      window.confirm=function(msg){
        console.log('[DIALOG] [CONFIRM] '+String(msg));
        var r=window.__hDialogAwait('confirm',String(msg),'');
        return r.answered?(r.value==='true'):false;
      };
      window.prompt=function(msg,def){
        console.log('[DIALOG] [PROMPT] '+String(msg)+(def?' (default: '+def+')':''));
        var r=window.__hDialogAwait('prompt',String(msg),def||'');
        return r.answered?r.value:(def||'');
      };
      // Signal parent when DOM structure changes (parent reads tree via executeJavaScript)
      var _t=null;
      try{
        var mo=new MutationObserver(function(){clearTimeout(_t);_t=setTimeout(function(){console.log('[H:domChanged]')},150)});
        mo.observe(document.body,{childList:true,subtree:true});
      }catch(e){}
      console.log('[H:domChanged]');
      // Highlight function for tree→page sync
      window.__hHighlight=function(uid){
        var el=document.querySelector('[data-__huid="'+uid.replace(/"/g,'\\"')+'"]');
        if(el){
          el.style.outline='2px solid #4ec94e';el.style.outlineOffset='-1px';
          el.scrollIntoView({block:'nearest',behavior:'smooth'});
          setTimeout(function(){el.style.outline='';el.style.outlineOffset=''},2000);
        }
      };
      // Hover/click handlers for inspect mode
      var infoBar=document.createElement('div');
      infoBar.id='__h_inspector_info';
      infoBar.style.cssText='position:fixed;bottom:4px;left:4px;max-width:calc(100vw - 8px);min-height:20px;max-height:42px;background:rgba(30,30,30,0.95);color:#ccc;font:10.5px/1.3 monospace;border-radius:3px;z-index:2147483647;padding:2px 6px;display:none;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      document.body.appendChild(infoBar);
      window.__hLastEl=null;
      document.addEventListener('mouseover',function(e){
        if(!window.__hInspectorActive)return;
        var t=e.target;
        if(!t||t===document.body||t===document.documentElement||t===infoBar)return;
        if(window.__hLastEl&&window.__hLastEl!==t){try{window.__hLastEl.style.outline=''}catch(x){}}
        try{t.style.outline='2px solid #4ec94e';t.style.outlineOffset='-1px'}catch(x){}
        window.__hLastEl=t;
        // Walk up to find closest ancestor with data-__huid
        var el=t;while(el&&el!==document.body&&el!==document.documentElement){var uid=el.getAttribute('data-__huid');if(uid){console.log('[H:domNode] '+uid);break}el=el.parentElement}
        var tag=t.tagName.toLowerCase();
        var tid=t.id?'#'+t.id:'';
        var tcls=t.className&&typeof t.className==='string'?'.'+t.className.trim().split(/\s+/).filter(Boolean).join('.'):'';
        var rect=t.getBoundingClientRect();
        var cs=getComputedStyle(t);
        infoBar.style.display='block';
        infoBar.textContent='<'+tag+tid+tcls+'>  '+rect.width.toFixed(0)+'\xD7'+rect.height.toFixed(0)+' @ ('+rect.left.toFixed(0)+', '+rect.top.toFixed(0)+')  |  '+cs.display+' | '+cs.position+(cs.position!=='static'?' ('+cs.top+','+cs.left+')':'')+'  |  color:'+cs.color+' bg:'+cs.backgroundColor;
      },true);
      document.addEventListener('click',function(e){
        if(!window.__hInspectorActive)return;
        e.preventDefault();e.stopPropagation();
        var t=e.target;
        // Walk up to find closest ancestor with data-__huid
        var el=t;var uid=null;while(el&&el!==document.body&&el!==document.documentElement){uid=el.getAttribute('data-__huid');if(uid)break;el=el.parentElement}
        if(uid){
          var tag=(el||t).tagName.toLowerCase();
          var id=(el||t).id?'#'+(el||t).id:'';
          var rect=(el||t).getBoundingClientRect();
          console.log('[H:inspectInfo] <'+tag+id+'>  '+rect.width.toFixed(0)+'\xD7'+rect.height.toFixed(0));
          console.log('[H:inspectNode] '+uid);
        }
        window.__hInspectorActive=false;
        if(window.__hLastEl){try{window.__hLastEl.style.outline=''}catch(x){}window.__hLastEl=null;}
        infoBar.style.display='none';
        // Clean up inspect styles + blockers
        var ss=document.getElementById('__h_inspect_style');if(ss)ss.remove();
        if(window.__hInspectBlocker){var b=window.__hInspectBlocker;['mousedown','mouseup','keydown','keypress','submit','focus','auxclick','dblclick','contextmenu'].forEach(function(n){document.removeEventListener(n,b,true)});delete window.__hInspectBlocker}
        console.log('[H:inspectEnd] ');
      },true);
    })()
  `, [viewportWidth, viewportHeight]);

  // JS code executed on demand to walk the DOM and return the tree directly
  const DOM_WALK_CODE = `(function(){try{if(!document.body||document.body.children.length===0)return[];var nodes=[],seq=0;function w(el,prefix){if(!el)return;var idx=0;Array.from(el.children).forEach(function(child){var uid=prefix?prefix+'.'+idx:String(idx);try{child.setAttribute('data-__huid',uid)}catch(e){}var tag=child.tagName.toLowerCase();var id=child.id?'#'+child.id:'';var cls=child.className&&typeof child.className==='string'?'.'+child.className.trim().split(/\\s+/).filter(Boolean).join('.'):'';var txt=(child.textContent||'').trim().substring(0,60);var attrs='';if(child.attributes){for(var i=0;i<child.attributes.length;i++){var a=child.attributes[i];if(a.name!=='class'&&a.name!=='id'&&a.name!=='style')attrs+=' '+a.name+(a.value?'=\"'+a.value+'\"':'');}}nodes.push({uid:uid,tag:tag,id:id,classes:cls,text:txt,attrs:attrs});if(seq++<2000&&child.children.length>0&&uid.split('.').length<6)w(child,uid);idx++})}w(document.body,'');return nodes}catch(e){return[]}})()`;

  // Read DOM tree directly from the desktop webview via executeJavaScript return value
  const readDesktopDomTree = useCallback(async () => {
    const view = webviewRef.current;
    if (!view || !webviewReadyRef.current) return;
    try {
      const nodes = await view.executeJavaScript?.(DOM_WALK_CODE, false);
      if (Array.isArray(nodes)) {
        window.postMessage({ __hDevtools: true, type: "domTree", nodes }, "*");
      }
    } catch { /* webview may not be ready */ }
  }, []);

  // Ref for onNewTab to avoid re-triggering the webview effect when browserTabs changes
  const onNewTabRef = useRef(onNewTab);
  onNewTabRef.current = onNewTab;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  useEffect(() => {
    if (!isDesktop) return;
    const view = webviewRef.current;
    if (!view) return;

    // If webview is already loaded (dom-ready fired before effect), sync immediately
    try {
      const existing = view.getURL?.();
      if (existing && existing !== "about:blank") {
        syncDesktopState("initial");
      }
    } catch {}

    // ── Event listeners ──
    const onDidFinishLoad = () => {
      navigatingRef.current = false;
      setLoadingState(false);
      setPageError(null);
      syncDesktopState("did-finish-load");
      if (webviewReadyRef.current) {
        void view.executeJavaScript?.(DESKTOP_INJECT_CODE, false).catch(() => {});
        // Detect JSON responses that would render as white page
        void view.executeJavaScript?.(`
          (function(){
            var body = document.body;
            if (!body) return;
            var text = (body.textContent || '').trim();
            if (!text.startsWith('{') && !text.startsWith('[')) return;
            // Count non-H children (skip __h_inspector_info injected at dom-ready)
            var nonHChildren = [];
            for (var i = 0; i < body.children.length; i++) {
              if (body.children[i].id !== '__h_inspector_info') {
                nonHChildren.push(body.children[i]);
              }
            }
            var isJsonBody = nonHChildren.length === 0
              || (nonHChildren.length === 1 && nonHChildren[0].tagName === 'PRE');
            if (isJsonBody) {
              try {
                var parsed = JSON.parse(text);
                var formatted = JSON.stringify(parsed, null, 2);
                body.innerHTML = '<pre style="font:12px monospace;padding:12px;white-space:pre-wrap;color:#ccc;background:#1a1a1a;margin:0;min-height:100vh;">' + formatted.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
              } catch(e) {}
            }
          })()
        `, false).catch(() => {});
        // Read final DOM state
        void readDesktopDomTree();
      }
    };
    const onDidNavigate = () => { navigatingRef.current = false; syncDesktopState("did-navigate"); };
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
      onNewTabRef.current?.(popupUrl);
    };
    const handleDomReady = () => {
      webviewReadyRef.current = true;
      syncDesktopState("dom-ready");
      // Detect JSON responses BEFORE injecting H code (which adds children to body)
      void view.executeJavaScript?.(`
        (function(){
          var body = document.body;
          if (!body) return;
          var text = (body.textContent || '').trim();
          var isJsonBody = body.children.length === 0
            || (body.children.length === 1 && body.children[0] && body.children[0].tagName === 'PRE');
          if (isJsonBody && (text.startsWith('{') || text.startsWith('['))) {
            try {
              var parsed = JSON.parse(text);
              var formatted = JSON.stringify(parsed, null, 2);
              body.innerHTML = '<pre style="font:12px monospace;padding:12px;white-space:pre-wrap;color:#ccc;background:#1a1a1a;margin:0;min-height:100vh;">' + formatted.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
            } catch(e) {}
          }
        })()
      `, false).catch(() => {});
      void view.executeJavaScript?.(DESKTOP_INJECT_CODE, false).catch(() => {});
    };
    const handleDidFailLoad = () => { navigatingRef.current = false; setLoadingState(false); setPageError("Failed to load page. The server may not be running or the URL is invalid."); };
    const handleConsoleMessage = (event: Event) => {
      const details = event as Event & {
        level?: number;
        message?: string;
        line?: number;
        sourceId?: string;
      };
      const msg = details.message || "";

      // Internal signals from injected code — not forwarded as console entries
      if (msg.startsWith("[H:")) {
        if (msg === "[H:domChanged]") {
          // DOM structure changed — re-read the tree directly
          void readDesktopDomTree();
          return;
        }
        const match = msg.match(/^\[H:(domNode|inspectNode|inspectEnd|inspectInfo)\]\s*(.*)/s);
        if (match) {
          const kind = match[1];
          const text = match[2];
          if (kind === "domNode") {
            window.postMessage({ __hDevtools: true, type: "hoverNode", uid: text }, "*");
          } else if (kind === "inspectNode") {
            window.postMessage({ __hDevtools: true, type: "inspectNode", tagHint: text }, "*");
          } else if (kind === "inspectEnd") {
            setInspectMode(false);
            window.postMessage({ __hDevtools: true, type: "inspectEnd" }, "*");
            window.postMessage({ __hDevtools: true, type: "inspectState", active: false }, "*");
          } else if (kind === "inspectInfo") {
            const entry: BrowserConsoleEntry = {
              id: `browser-${Date.now()}-${++consoleSeqRef.current}`,
              level: "info",
              text,
              time: Date.now(),
            };
            onConsoleEntryRef.current?.(tabIdRef.current, entry);
          }
        }
        return;
      }

      // Native console output — forward directly using the event's numeric level
      const levelMap: Record<number, BrowserConsoleEntry["level"]> = { 0: "log", 1: "log", 2: "warn", 3: "error" };
      const entry: BrowserConsoleEntry = {
        id: `browser-${Date.now()}-${++consoleSeqRef.current}`,
        level: levelMap[details.level ?? 1] || "log",
        text: msg,
        time: Date.now(),
        source: details.sourceId ? `${details.sourceId}:${details.line}` : undefined,
      };
      onConsoleEntryRef.current?.(tabIdRef.current, entry);
    };
    const handleIpcMessage = (event: Event) => {
      const details = event as Event & {
        channel?: string;
        args?: unknown[];
      };
      if (details.channel === "h:browserOpenUrl") {
        const popupUrl = typeof details.args?.[0] === "string" ? details.args[0] : "";
        if (popupUrl && popupUrl !== "about:blank") {
          onNewTabRef.current?.(popupUrl);
        }
      }
    };

    // Only main-frame document navigations should flip the loading state.
    // `did-start-loading` fires for ANY load — including subframes and background
    // activity (ads, lazy iframes, polling resources) — which would leave the
    // UI stuck "loading" long after the page itself has finished.
    const handleDidStartNavigation = (event: Event) => {
      const details = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
      if (details.isMainFrame === false || details.isInPlace) return;
      setLoadingState(true);
    };
    const handleStopLoading = () => setLoadingState(false);

    view.addEventListener("dom-ready", handleDomReady);
    view.addEventListener("did-start-navigation", handleDidStartNavigation);
    view.addEventListener("did-stop-loading", handleStopLoading);
    view.addEventListener("did-finish-load", onDidFinishLoad);
    view.addEventListener("did-navigate", onDidNavigate);
    view.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    view.addEventListener("page-title-updated", onPageTitleUpdated);
    view.addEventListener("new-window", handleNewWindow);
    view.addEventListener("did-fail-load", handleDidFailLoad);
    view.addEventListener("console-message", handleConsoleMessage);
    view.addEventListener("ipc-message", handleIpcMessage);

    const poll = setInterval(() => syncDesktopState("poll"), 300);

    return () => {
      webviewReadyRef.current = false;
      clearInterval(poll);
      view.removeEventListener("dom-ready", handleDomReady);
      view.removeEventListener("did-start-navigation", handleDidStartNavigation);
      view.removeEventListener("did-stop-loading", handleStopLoading);
      view.removeEventListener("did-finish-load", onDidFinishLoad);
      view.removeEventListener("did-navigate", onDidNavigate);
      view.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      view.removeEventListener("page-title-updated", onPageTitleUpdated);
      view.removeEventListener("new-window", handleNewWindow);
      view.removeEventListener("did-fail-load", handleDidFailLoad);
      view.removeEventListener("console-message", handleConsoleMessage);
      view.removeEventListener("ipc-message", handleIpcMessage);
    };
  }, [isDesktop, syncDesktopState, tabId, currentUrl, viewportWidth, viewportHeight]);

  // Re-inject viewport meta when preset changes (only if webview is ready)
  useEffect(() => {
    if (!isDesktop) return;
    const view = webviewRef.current;
    if (!view || !webviewReadyRef.current) return;
    void view.executeJavaScript?.(DESKTOP_INJECT_CODE, false).catch(() => {});
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
  }, [viewportWidth, viewportHeight, currentUrl]);

  useEffect(() => {
    if (!isDesktop) return;
    const origin = getOrigin(currentUrl);
    if (!origin) return;
    void window.hDesktop?.setSitePermissions?.(origin, { ...perms }).catch(() => {});
  }, [currentUrl, isDesktop, perms]);

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

  // ── Sandbox — allow-scripts for JS execution, allow-same-origin for same-origin access,
  // allow-forms for form submission, allow-popups for window.open.
  // Blocks: top-navigation (prevents escape), plugins, modals, pointer-lock, downloads.
  const sandboxAttr = "allow-scripts allow-same-origin allow-forms allow-popups";

  const navigate = useCallback(() => {
    if (!tabId) return;
    // Read from DOM input — for "Go" button clicks React has flushed
    // the state update, so inputRef.current.value is accurate.
    const raw = inputRef.current?.value?.trim();
    if (!raw) return;
    let final: string;
    if (isUrlLike(raw)) {
      final = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    } else {
      final = `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
    }

    liveUrlRef.current = final;
    navigatingRef.current = true;
    setPageError(null);
    setNavUrl(final);
    setCurrentUrl(final);
    setInputUrl(final);
    setSecure(isHttps(final));
    onUrlChange?.(tabId, final);

    // Explicit loadURL for desktop webview (src attribute update alone may not trigger navigation)
    if (isDesktop) {
      webviewRef.current?.loadURL?.(toProxySrcAbs(final));
    }
  }, [onUrlChange, tabId, isDesktop, toProxySrcAbs]);

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

  // DevTools button — opens Browser Console in terminal pane
  const toggleDevtools = useCallback(() => {
    onOpenDevtools?.();
  }, [onOpenDevtools]);

  const toggleInspect = useCallback(() => {
    const next = !inspectMode;
    window.postMessage({ __h: true, type: "toggle-inspect", active: next }, "*");
    if (next) {
      // Open terminal pane to browser console > elements
      onOpenDevtools?.();
      window.postMessage({ __hDevtools: true, type: "showElements" }, "*");
    }
  }, [inspectMode, onOpenDevtools]);

  // Inject element inspector into iframe on demand
  const injectInspector = useCallback((iframe: HTMLIFrameElement) => {
    try {
      const win = iframe.contentWindow as any;
      if (!win || win.__hInspectorActive) return;
      const doc = win.document;
      if (!doc || !doc.body) return;

      win.__hInspectorActive = true;
      let lastEl: Element | null = null;

      // Build and send DOM tree
      const sendTree = () => {
        const nodes: Array<{ uid: string; tag: string; id: string; classes: string; text: string; attrs: string }> = [];
        let _seq = 0;
        const walk = (el: Element | null, prefix: string) => {
          if (!el) return;
          let idx = 0;
          for (const child of Array.from(el.children)) {
            const uid = prefix ? prefix + "." + idx : String(idx);
            const tag = child.tagName.toLowerCase();
            const id = child.id ? "#" + child.id : "";
            const classes = child.className && typeof child.className === "string"
              ? "." + child.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
            const text = (child.textContent || "").trim().substring(0, 60);
            let attrs = "";
            if (child.attributes) {
              for (let i = 0; i < child.attributes.length; i++) {
                const a = child.attributes[i];
                if (a.name !== "class" && a.name !== "id" && a.name !== "style") {
                  attrs += " " + a.name + (a.value ? "=\"" + a.value + "\"" : "");
                }
              }
            }
            nodes.push({ uid, tag, id, classes, text, attrs });
            // Set data attribute for tree→page highlight lookup
            try { child.setAttribute("data-__huid", uid); } catch {}
            if (_seq++ < 2000 && child.children.length > 0 && uid.split(".").length < 6) {
              walk(child, uid);
            }
            idx++;
          }
        };
        walk(doc.body, "");
        window.postMessage({ __h: true, type: "domTree", nodes }, "*");
      };

      // Highlight element by uid (tree→page hover)
      win.__hHighlight = (targetUid: string) => {
        try {
          const el = doc.querySelector('[data-__huid="' + targetUid.replace(/"/g, '\\"') + '"]');
          if (el) {
            if (lastEl) (lastEl as HTMLElement).style.outline = "";
            (el as HTMLElement).style.outline = "2px solid #4ec94e";
            (el as HTMLElement).style.outlineOffset = "-1px";
            lastEl = el as Element;
            el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
            setTimeout(() => {
              try { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } catch {}
              if (lastEl === el) lastEl = null;
            }, 2000);
          }
        } catch {}
      };

      // Send tree initially
      sendTree();

      // Force arrow cursor + block page interactions during inspect
      const inspectStyle = doc.createElement("style");
      inspectStyle.id = "__h_inspect_style";
      inspectStyle.textContent = "*{cursor:default!important}";
      doc.head.appendChild(inspectStyle);
      const blockEvent = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
      const blockEvents = ["mousedown", "mouseup", "keydown", "keypress", "submit", "focus", "auxclick", "dblclick", "contextmenu"];
      blockEvents.forEach((n) => doc.addEventListener(n, blockEvent, true));

      // Info bar at bottom of viewport (multi-line tooltip)
      const infoBar = doc.createElement("div");
      infoBar.id = "__h_inspector_info";
      infoBar.style.cssText = "position:fixed;bottom:4px;left:4px;max-width:calc(100vw - 8px);min-height:20px;max-height:42px;background:rgba(30,30,30,0.95);color:#ccc;font:10.5px/1.3 monospace;border-radius:3px;z-index:2147483647;padding:2px 6px;display:none;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      doc.body.appendChild(infoBar);

      const onMouseOver = (e: MouseEvent) => {
        const target = e.target as Element;
        if (!target || target === infoBar || target === doc.body || target === doc.documentElement) return;

        if (lastEl && lastEl !== target) {
          (lastEl as HTMLElement).style.outline = "";
        }

        (target as HTMLElement).style.outline = "2px solid #4ec94e";
        (target as HTMLElement).style.outlineOffset = "-1px";
        lastEl = target;

        const tag = target.tagName.toLowerCase();
        const id = target.id ? "#" + target.id : "";
        const cls = target.className && typeof target.className === "string"
          ? "." + target.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
        const rect = target.getBoundingClientRect();
        const cs = win.getComputedStyle(target);
        const boxModel = cs.display + " | " + cs.position + (cs.position !== "static" ? " (" + cs.top + "," + cs.left + ")" : "");
        const sizeText = rect.width.toFixed(0) + "\xD7" + rect.height.toFixed(0) + " @ (" + rect.left.toFixed(0) + ", " + rect.top.toFixed(0) + ")";
        const colorInfo = "color:" + cs.color + " bg:" + cs.backgroundColor;
        infoBar.style.display = "block";
        infoBar.textContent = "<" + tag + id + cls + ">  " + sizeText + "  |  " + boxModel + "  |  " + colorInfo;

        // Walk up to find closest ancestor with data-__huid
        let el: Element | null = target;
        while (el && el !== doc.body && el !== doc.documentElement) {
          const uid = el.getAttribute("data-__huid");
          if (uid) { window.postMessage({ __h: true, type: "hoverNode", uid }, "*"); break; }
          el = el.parentElement;
        }
      };

      const onClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.target as Element;
        if (!target || target === infoBar) return;

        // Walk up to find closest ancestor with data-__huid
        let el: Element | null = target;
        let uid: string | null = null;
        while (el && el !== doc.body && el !== doc.documentElement) {
          uid = el.getAttribute("data-__huid");
          if (uid) break;
          el = el.parentElement;
        }
        if (uid && el) {
          const tag = el.tagName.toLowerCase();
          const eid = el.id ? "#" + el.id : "";
          const rect = el.getBoundingClientRect();
          window.postMessage({
            __h: true,
            type: "console",
            level: "info",
            text: "<" + tag + eid + ">  " + rect.width.toFixed(0) + "\xD7" + rect.height.toFixed(0),
            time: Date.now(),
            source: "inspect",
          }, "*");
          window.postMessage({ __h: true, type: "inspectNode", uid }, "*");
        }
        // Turn off inspect
        win.__hInspectorCleanup?.();
        window.postMessage({ __h: true, type: "toggle-inspect", active: false }, "*");
      };

      doc.addEventListener("mouseover", onMouseOver, true);
      doc.addEventListener("click", onClick, true);

      win.__hInspectorCleanup = () => {
        if (lastEl) (lastEl as HTMLElement).style.outline = "";
        infoBar.remove();
        inspectStyle.remove();
        blockEvents.forEach((n) => doc.removeEventListener(n, blockEvent, true));
        doc.removeEventListener("mouseover", onMouseOver, true);
        doc.removeEventListener("click", onClick, true);
        delete win.__hInspectorActive;
        delete win.__hInspectorCleanup;
        delete win.__hHighlight;
      };
    } catch { /* cross-origin */ }
  }, []);
  injectInspectorRef.current = injectInspector;

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!tabId) return;

    // Read directly from the DOM input — React's controlled value hasn't
    // flushed yet, so inputRef.current.value has the user's actual keystrokes.
    const raw = e.currentTarget.value.trim();
    if (!raw) return;

    let final: string;
    if (isUrlLike(raw)) {
      final = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    } else {
      final = `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
    }

    liveUrlRef.current = final;
    navigatingRef.current = true;
    setPageError(null);
    setNavUrl(final);
    setCurrentUrl(final);
    setInputUrl(final);
    setSecure(isHttps(final));
    onUrlChange?.(tabId, final);

    if (isDesktop) {
      webviewRef.current?.loadURL?.(toProxySrcAbs(final));
    }

    // Blur the input after navigation
    e.currentTarget.blur();
  }, [tabId, isDesktop, onUrlChange, toProxySrcAbs]);

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
  const desktopSrc = toProxySrcAbs(navTabId === tabId ? navUrl : url);

  // ── Agent tool methods exposed via ref ──
  const getIframe = useCallback((): HTMLIFrameElement | null => {
    if (isDesktop) return null;
    return iframeRef.current;
  }, [isDesktop]);
  const getWebview = useCallback((): BrowserGuest | null => {
    if (!isDesktop) return null;
    return webviewRef.current;
  }, [isDesktop]);

  const evalInPage = useCallback(async (code: string): Promise<string> => {
    try {
      const wv = getWebview();
      if (wv) {
        const result = await (wv as any).executeJavaScript(code);
        return String(result ?? "");
      }
      const win = getIframe()?.contentWindow as any;
      if (win) {
        const result = (win as any).eval?.(code);
        // eval in the iframe returns a Promise for async scripts — await it so
        // waitForElement / captureScreenshotImage work in web (non-Electron) mode.
        if (result && typeof result.then === "function") {
          return String(await result);
        }
        return String(result ?? "");
      }
    } catch (e: any) { return `Error: ${e?.message || e}`; }
    return "No browser page loaded.";
  }, [getIframe, getWebview]);

  // Check if an evalInPage result indicates a navigation-triggered error.
  // When a click causes a page navigation, Electron's executeJavaScript throws
  // GUEST_VIEW_MANAGER_CALL because the renderer process is torn down.
  const handleNavigationError = useCallback(async (result: string, fallback: string): Promise<string> => {
    if (result.startsWith("Error:") && (result.includes("GUEST_VIEW_MANAGER_CALL") || result.includes("Script failed to execute"))) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const wv = getWebview();
        const newUrl = wv ? fromProxySrc((wv as any).getURL() || "") : "";
        return fallback + (newUrl ? " (navigation triggered, now at " + newUrl + ")" : " (navigation triggered)");
      } catch {
        return fallback + " (navigation triggered)";
      }
    }
    return result;
  }, [getWebview]);

  // ── Coordinate-based interaction ──
  // All x,y arguments are in the pixel space of the last browser_screenshot
  // image. They are scaled to the guest page's viewport coordinates before any
  // event is dispatched, so the agent can simply point at what it sees in the
  // screenshot image.
  const scaleToViewport = useCallback((x: number, y: number): { x: number; y: number } => {
    const c = lastCaptureRef.current;
    if (!c || c.imageW <= 0 || c.imageH <= 0 || c.viewportW <= 0 || c.viewportH <= 0) return { x, y };
    return {
      x: Math.round((x * c.viewportW) / c.imageW),
      y: Math.round((y * c.viewportH) / c.imageH),
    };
  }, []);

  const typeIntoElement = useCallback(async (x: number, y: number, text: string) => {
    const { x: vx, y: vy } = scaleToViewport(x, y);
    const c = lastCaptureRef.current;
    const priorScale = c && c.imageW > 0 && c.viewportW > 0 ? c.viewportW / c.imageW : 1;
    const result = await evalInPage(`
      (() => {
        ${PAGE_TARGET_HELPERS}
        const res = hResolveTarget(${vx}, ${vy}, ${priorScale});
        const field = res.el;
        const tag = field.tagName ? field.tagName.toLowerCase() : '';
        const editable = tag === 'input' || tag === 'textarea' || field.isContentEditable === true;
        if (!editable) {
          return 'no text field near (' + ${vx} + ',' + ${vy} + ') — found ' + hElLabel(field) + '. Re-screenshot and click directly on the input you see in the image.';
        }

        // Click the field first — reactive frameworks (React/Vue) need real mouse events
        const rect = field.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const fvx = Math.max(0, Math.min(cx, window.innerWidth - 1));
        const fvy = Math.max(0, Math.min(cy, window.innerHeight - 1));
        const mouseOpts = { clientX: fvx, clientY: fvy, screenX: fvx, screenY: fvy, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
        const ptrOpts = { clientX: fvx, clientY: fvy, screenX: fvx, screenY: fvy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, view: window };
        field.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
        field.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        field.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
        field.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        field.dispatchEvent(new MouseEvent('click', mouseOpts));
        try { field.focus(); } catch(_) {}
        hShowPointer(fvx, fvy, 'type');

        const text = ${JSON.stringify(text)};
        if (field.isContentEditable) {
          // contenteditable: replace the content and notify frameworks
          field.textContent = text;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
          return text
            ? 'typed "' + text + '" into contenteditable at (${vx},${vy})'
            : 'cleared contenteditable at (${vx},${vy})';
        }

        // Resolve the native value setter (React overrides HTMLInputElement.prototype.value)
        const nativeSetter = Object.getOwnPropertyDescriptor(
          (field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement).prototype, 'value'
        );
        const setValue = nativeSetter && nativeSetter.set
          ? function(v) { nativeSetter.set.call(field, v); }
          : function(v) { field.value = v; };

        // Select all, clear via native setter, notify frameworks
        if (typeof field.select === 'function') field.select();
        setValue('');
        field.dispatchEvent(new Event('input', { bubbles: true }));

        if (!text) {
          field.dispatchEvent(new Event('change', { bubbles: true }));
          return 'cleared element at (${vx},${vy})';
        }

        // Type each character with native input events + native value setter
        for (const ch of text) {
          field.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
          field.dispatchEvent(new KeyboardEvent('keypress', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
          const start = field.selectionStart || 0;
          const newVal = field.value.slice(0, start) + ch + field.value.slice(field.selectionEnd || start);
          setValue(newVal);
          field.selectionStart = field.selectionEnd = start + 1;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
        }
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return 'typed "' + text + '" into ' + tag + ' at (${vx},${vy})';
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    return result;
  }, [evalInPage, scaleToViewport]);

  // Short header for the page (URL + title). The pixel screenshot is the
  // primary output of browser_screenshot; this text only identifies the page.
  const getScreenshotHeader = useCallback(async (): Promise<string> => {
    return evalInPage(`
      (() => {
        return 'URL: ' + window.location.href + '\\nTitle: ' + document.title;
      })()
    `);
  }, [evalInPage]);

  // Capture the visible page as a base64 PNG data URL plus its pixel size. On
  // desktop this captures the Electron webview in the main process
  // (webContents.capturePage via the hDesktop IPC bridge — the <webview>
  // element's own capturePage throws "An object could not be cloned" over
  // IPC). In web mode (iframe) it falls back to DOM rasterization (SVG
  // foreignObject → canvas), inlining page CSS/images through the same-origin
  // reverse proxy and retrying in a taint-safe mode if the canvas is blocked.
  // The image and guest viewport sizes are recorded so coordinate tools can
  // map screenshot pixels to viewport pixels.
  const captureScreenshotImage = useCallback(async (): Promise<{ url: string; imageW: number; imageH: number }> => {
    // Remove any live pointer marker so the transient click/hover indicator
    // never shows up in the screenshot handed to the vision model.
    await evalInPage(`(function(){try{var m=window.__hPointerMarker;if(m&&m.parentNode)m.parentNode.removeChild(m);window.__hPointerMarker=null;}catch(e){}})()`).catch(() => {});
    // ── Desktop: main-process webview capture (no taint possible) ──
    const desktop = (window as any).hDesktop;
    const wv = getWebview() as (BrowserGuest & { getWebContentsId?: () => number }) | null;
    let url = "";
    if (wv && typeof wv.getWebContentsId === "function" && desktop && typeof desktop.captureBrowserPage === "function") {
      try {
        const b64 = await desktop.captureBrowserPage(wv.getWebContentsId());
        if (b64) url = "data:image/png;base64," + b64;
      } catch { /* fall through to DOM rasterization */ }
    }

    // ── Web / fallback: DOM rasterization (full → safe) ──
    if (!url) {
      url = await evalInPage(`
      (() => {
        // Cap at 1024x1024 so vision APIs don't downscale the image further:
        // the coordinates the model reports then match the screenshot 1:1.
        const MAX_W = 1024, MAX_H = 1024, MAX_CSS = 150000, MAX_IMGS = 24, MAX_HTML = 600000;
        const vw = Math.min(document.documentElement.clientWidth || window.innerWidth || 1280, MAX_W);
        const vh = Math.min(window.innerHeight || document.documentElement.clientHeight || 800, MAX_H);

        // Resolve any URL (relative or absolute) through the same-origin proxy.
        const proxyUrl = function (u) {
          try { return '/_browser?url=' + encodeURIComponent(new URL(u, document.baseURI).href); }
          catch (e) { return null; }
        };
        const fetchText = function (u) {
          return fetch(u, { credentials: 'include' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; });
        };
        const fetchDataUrl = function (u) {
          return fetch(u, { credentials: 'include' }).then(function (r) { return r.ok ? r.blob() : null; })
            .then(function (b) {
              if (!b) return null;
              return new Promise(function (res) {
                const fr = new FileReader();
                fr.onload = function () { res(String(fr.result)); };
                fr.onerror = function () { res(null); };
                fr.readAsDataURL(b);
              });
            })
            .catch(function () { return null; });
        };

        // mode: 'full' (inline everything through the proxy) or 'safe' (strip
        // every external reference so the canvas can never be tainted).
        const build = function (mode) {
          // 1. Styles: inline <style> blocks + proxied <link rel=stylesheet>.
          const styleParts = [];
          try { document.querySelectorAll('style').forEach(function (s) { if (s.textContent) styleParts.push(s.textContent); }); } catch (e) {}
          const links = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"]'));
          const fetchCss = Promise.all(links.map(function (link) {
            const href = link.href || '';
            if (!href) return Promise.resolve('');
            const p = proxyUrl(href);
            return p ? fetchText(p) : Promise.resolve('');
          })).then(function (texts) { return texts.join('\\n'); });

          return fetchCss.then(function (linkCss) {
            styleParts.push(linkCss);
            let css = styleParts.join('\\n');
            if (mode === 'full') {
              // Rewrite external url()/@import references to same-origin proxy URLs.
              css = css.replace(/(url\\(\\s*['"]?)([^'")]+)(['"]?\\s*\\))/gi, function (m, pre, u, post) {
                const p = proxyUrl(u.trim());
                return p ? pre + p + post : 'none';
              });
              css = css.replace(/@import\\s+['"]([^'"]+)['"]/gi, function (m, u) {
                const p = proxyUrl(u.trim());
                return p ? '@import url(' + p + ');' : m;
              });
            } else {
              css = css.replace(/url\\([^)]*\\)/gi, 'none').replace(/@import\\s+[^;]+;/gi, '');
            }
            if (css.length > MAX_CSS) css = css.slice(0, MAX_CSS);

            // 2. Clone the document; drop elements that can't render or that
            //    would leak the viewport (scripts, iframes, video, canvases, links, base).
            const clone = document.documentElement.cloneNode(true);
            clone.querySelectorAll('script, iframe, video, audio, canvas, link, meta, noscript, object, embed, base').forEach(function (el) { el.remove(); });

            // 2b. Neutralize any remaining element that can still fetch an external
            //     resource and thereby taint the canvas (image inputs, inline SVG refs,
            //     picture/source, legacy background attributes).
            clone.querySelectorAll('input[type="image"]').forEach(function (el) { el.removeAttribute('src'); el.removeAttribute('srcset'); });
            clone.querySelectorAll('svg image, svg use, svg feImage').forEach(function (el) {
              const h = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
              if (h && !h.startsWith('#') && !h.startsWith('data:')) {
                el.removeAttribute('href');
                el.removeAttribute('xlink:href');
              }
            });
            clone.querySelectorAll('[background]').forEach(function (el) { el.removeAttribute('background'); });
            if (mode === 'safe') {
              clone.querySelectorAll('picture, source, track').forEach(function (el) { el.remove(); });
            }

            // 3. Images: inline via proxy (full) or replace with placeholders (safe).
            const imgs = Array.prototype.slice.call(clone.querySelectorAll('img'));
            const pending = [];
            if (mode === 'full') {
              let converted = 0;
              for (let i = 0; i < imgs.length && converted < MAX_IMGS; i++) {
                const img = imgs[i];
                const src = img.getAttribute('src') || img.currentSrc || '';
                if (!src || src.startsWith('data:')) continue;
                const p = proxyUrl(src);
                if (!p) { img.remove(); continue; }
                pending.push(fetchDataUrl(p).then(function (d) {
                  if (d) img.setAttribute('src', d);
                  else img.remove();
                }));
                converted++;
              }
            } else {
              imgs.forEach(function (img) {
                const alt = (img.getAttribute('alt') || '').trim();
                const box = document.createElement('div');
                box.style.cssText = 'display:inline-block;min-width:24px;min-height:24px;background:#e9e9e9;border:1px dashed #aaa;color:#777;font-size:11px;padding:2px 4px;box-sizing:border-box;vertical-align:middle;';
                box.textContent = alt ? '[img: ' + alt + ']' : '[image]';
                if (img.parentNode) img.parentNode.replaceChild(box, img);
              });
            }

            return Promise.all(pending).then(function () {
              // 4. Serialize to SVG, then back to a Blob (avoids data-URL size limits).
              let html = clone.outerHTML;
              if (mode === 'full') {
                // Inline style attributes can hold url() refs too — proxy them.
                html = html.replace(/url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/gi, function (m, u) {
                  const p = proxyUrl(u.trim());
                  return p ? 'url(' + p + ')' : 'none';
                });
              } else {
                html = html.replace(/url\\([^)]*\\)/gi, 'none');
              }
              if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
              const esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); };
              const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + vw + '" height="' + vh + '">'
                + '<style>' + esc(css) + '</style>'
                + '<foreignObject width="100%" height="100%">'
                + '<div xmlns="http://www.w3.org/1999/xhtml" style="overflow:hidden;width:' + vw + 'px;height:' + vh + 'px">'
                + esc(html)
                + '</div></foreignObject></svg>';
              return new Blob([svg], { type: 'image/svg+xml' });
            });
          });
        };

        const render = function (blob) {
          return new Promise(function (resolve) {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            const canvas = document.createElement('canvas');
            canvas.width = vw; canvas.height = vh;
            const ctx = canvas.getContext('2d');
            img.onload = function () {
              try {
                ctx.drawImage(img, 0, 0, vw, vh);
                resolve(canvas.toDataURL('image/png'));
              } catch (e) {
                resolve('__TAINT__');
              } finally {
                URL.revokeObjectURL(url);
              }
            };
            img.onerror = function () { URL.revokeObjectURL(url); resolve('Error: screenshot rasterization failed (SVG could not be rendered)'); };
            img.src = url;
          });
        };

        return build('full')
          .then(render)
          .then(function (r) {
            if (r === '__TAINT__') {
              // Full render was tainted — retry with external resources stripped.
              return build('safe').then(render).then(function (r2) {
                return r2 === '__TAINT__'
                  ? 'Error: page rasterization was blocked by the canvas taint policy even after stripping external resources'
                  : r2;
              });
            }
            return r;
          })
          .catch(function (e) { return 'Error: screenshot capture failed: ' + (e && e.message ? e.message : e); });
      })()
    `);
    }

    if (!url.startsWith("data:image/") || url.startsWith("data:image/svg")) {
      return { url, imageW: 0, imageH: 0 };
    }

    // Record the image's pixel size and the guest viewport size so coordinate
    // tools can map screenshot pixels → viewport pixels.
    const size = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve(null);
      im.src = url;
    });
    if (size) {
      let viewportW = 0;
      let viewportH = 0;
      const vs = await evalInPage(`[window.innerWidth, window.innerHeight].join('x')`).catch(() => "");
      const m = String(vs || "").match(/^(\d+)x(\d+)$/);
      if (m) { viewportW = Number(m[1]); viewportH = Number(m[2]); }
      lastCaptureRef.current = { imageW: size.w, imageH: size.h, viewportW, viewportH };
      return { url, imageW: size.w, imageH: size.h };
    }
    return { url, imageW: 0, imageH: 0 };
  }, [evalInPage, getWebview]);

  // Wait for an element matching a CSS selector to appear. Returns text content of first match.
  const waitForElement = useCallback(async (selector: string, timeoutMs: number = 5000): Promise<string> => {
    return evalInPage(`
      new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            resolve('[FOUND] ' + el.tagName.toLowerCase()
              + (el.id ? '#' + el.id : '')
              + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '')
              + ' text="' + (el.textContent || '').trim().slice(0, 200) + '"');
            return;
          }
          if (Date.now() - start > ${timeoutMs}) {
            resolve('NOT_FOUND: selector "${selector}" did not appear within ${timeoutMs}ms');
            return;
          }
          setTimeout(check, 200);
        };
        check();
      })
    `);
  }, [evalInPage]);

  // Get the last 50 captured console entries (log/warn/error) as a report.
  const getConsoleEntries = useCallback(async (): Promise<string> => {
    return evalInPage(`
      (() => {
        if (!window.__hConsoleEntries) return 'No console entries captured.';
        const entries = window.__hConsoleEntries.slice(-50);
        if (entries.length === 0) return 'Console is empty.';
        return entries.map(function(e) {
          return '[' + e.level.toUpperCase() + '] ' + e.text;
        }).join('\\n');
      })()
    `);
  }, [evalInPage]);

  // Get failed network requests since page load using PerformanceObserver.
  const getRequestErrors = useCallback(async (): Promise<string> => {
    return evalInPage(`
      (() => {
        if (!window.__hRequestErrors || window.__hRequestErrors.length === 0) {
          return 'No request errors captured.';
        }
        const errors = window.__hRequestErrors.slice(-30);
        return errors.map(function(r) {
          return '[' + r.status + '] ' + r.method + ' ' + r.url;
        }).join('\\n');
      })()
    `);
  }, [evalInPage]);

  const navigateTo = useCallback(async (url: string): Promise<void> => {
    if (activeTab) {
      liveUrlRef.current = url;
      navigatingRef.current = true;
      setPageError(null);
      setNavTabId(activeTab.id);
      setNavUrl(url);
      setCurrentUrl(url);
      setInputUrl(url);
      setSecure(isHttps(url));
      onUrlChange?.(activeTab.id, url);
      // Explicit loadURL for desktop webview — src attribute update via React
      // alone may not trigger navigation if the URL string hasn't changed.
      if (isDesktop) {
        webviewRef.current?.loadURL?.(toProxySrcAbs(url));
      }
    }
  }, [activeTab, onUrlChange, isDesktop]);

  const getInfo = useCallback((): string => {
    if (!activeTab || !currentUrl) return "No browser tab open. Use browser_navigate to open a URL first.";
    return `URL: ${currentUrl} | Title: ${activeTab.label || "(no title)"} | Loaded: ${loading ? "loading" : "yes"} | Tabs: ${tabs.length}`;
  }, [activeTab, currentUrl, loading, tabs]);

  const clearElement = useCallback(async (x: number, y: number): Promise<string> => {
    const result = await typeIntoElement(x, y, "");
    // typeIntoElement returns "cleared element at (x,y)" for empty text
    return result.startsWith("cleared") ? "Cleared element." : result;
  }, [typeIntoElement]);

  // ── Coordinate-based mouse ──
  // Uses enhanced event properties (pointerId, pointerType, button, buttons) so that
  // React/Vue and other frameworks properly recognize the synthetic events.
  // Clicks/right-clicks snap to the nearest interactive element's center so the
  // vision model's small coordinate errors don't cause misses.
  const mouseEvent = useCallback(async (x: number, y: number, eventType: string): Promise<string> => {
    // Anchor scale: captured image width / guest viewport width. hResolveTarget
    // searches around this to absorb CSS-zoom / meta-viewport / DPR scaling.
    const c = lastCaptureRef.current;
    const priorScale = c && c.imageW > 0 && c.viewportW > 0 ? c.viewportW / c.imageW : 1;
    return evalInPage(`
      (() => {
        ${PAGE_TARGET_HELPERS}
        const px = ${x}, py = ${y};
        const res = hResolveTarget(px, py, ${priorScale});
        const target = res.el;
        // Click/contextmenu: aim at the resolved element's center. Hover stays
        // at the exact point (hover effects depend on the precise position).
        let dx = px, dy = py;
        if (${JSON.stringify(eventType)} !== 'move') {
          const rect = target.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            dx = Math.max(0, Math.min(rect.left + rect.width / 2, window.innerWidth - 1));
            dy = Math.max(0, Math.min(rect.top + rect.height / 2, window.innerHeight - 1));
          }
        }
        const mouseOpts = { clientX: dx, clientY: dy, screenX: dx, screenY: dy, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
        const pointerOpts = { clientX: dx, clientY: dy, screenX: dx, screenY: dy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, view: window };
        let r;
        if (${JSON.stringify(eventType)} === 'click') {
          try { if (typeof target.focus === 'function') target.focus(); } catch(_) {}
          target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
          target.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          target.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
          target.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          target.dispatchEvent(new MouseEvent('click', mouseOpts));
          // Fallback: native click() for handlers that require isTrusted
          try { target.click(); } catch(_) {}
          r = 'clicked ' + hElLabel(target);
        } else if (${JSON.stringify(eventType)} === 'contextmenu') {
          target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
          target.dispatchEvent(new MouseEvent('mousedown', { ...mouseOpts, button: 2, buttons: 2 }));
          target.dispatchEvent(new MouseEvent('contextmenu', mouseOpts));
          target.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, button: 2, buttons: 0 }));
          r = 'right-clicked ' + hElLabel(target);
        } else {
          target.dispatchEvent(new MouseEvent('mousemove', mouseOpts));
          target.dispatchEvent(new PointerEvent('pointermove', pointerOpts));
          r = 'hovered on ' + hElLabel(target);
        }
        hShowPointer(dx, dy, ${JSON.stringify(eventType === "click" ? "click" : eventType === "contextmenu" ? "contextmenu" : "move")});
        return r;
      })()
    `);
  }, [evalInPage]);

  const clickCoords = useCallback(async (x: number, y: number): Promise<string> => {
    const { x: vx, y: vy } = scaleToViewport(x, y);
    const result = await mouseEvent(vx, vy, "click");
    const finalResult = await handleNavigationError(result, "click at (" + x + "," + y + ")");
    // Give the page a moment to process the click (framework state updates,
    // navigation, re-renders) before the agent's verification screenshot —
    // mirrors the old index-based click behavior. Without this, the screenshot
    // taken right after shows a stale page and looks like a failed click.
    if (finalResult.startsWith("clicked")) {
      await new Promise((r) => setTimeout(r, 400));
    }
    // Report the screenshot-image coordinates the agent chose (not the scaled
    // viewport ones) plus which element was actually clicked.
    return finalResult.startsWith("clicked") ? `click at (${x},${y}): ${finalResult}` : finalResult;
  }, [mouseEvent, handleNavigationError, scaleToViewport]);

  const moveMouse = useCallback(async (x: number, y: number): Promise<string> => {
    const { x: vx, y: vy } = scaleToViewport(x, y);
    const result = await mouseEvent(vx, vy, "move");
    return `hover at (${x},${y}): ${result}`;
  }, [mouseEvent, scaleToViewport]);

  const rightClick = useCallback(async (x: number, y: number): Promise<string> => {
    const { x: vx, y: vy } = scaleToViewport(x, y);
    const result = await mouseEvent(vx, vy, "contextmenu");
    return `right-click at (${x},${y}): ${result}`;
  }, [mouseEvent, scaleToViewport]);

  const scrollPage = useCallback(async (x: number, y: number, to?: string): Promise<string> => {
    if (to === "top") return evalInPage(`window.scrollTo(0, 0); 'Scrolled to top.';`);
    if (to === "bottom") return evalInPage(`window.scrollTo(0, document.body.scrollHeight); 'Scrolled to bottom.';`);
    return evalInPage(`window.scrollBy(${x || 0}, ${y || 0}); 'Scrolled by ${x || 0},${y || 0}.';`);
  }, [evalInPage]);

  const pressKey = useCallback(async (key: string): Promise<string> => {
    return evalInPage(`
      (() => {
        const el = document.activeElement || document.body;
        // Determine code and keyCode for common keys
        const keyMap = {
          Enter: { code: 'Enter', keyCode: 13 }, Escape: { code: 'Escape', keyCode: 27 },
          Tab: { code: 'Tab', keyCode: 9 }, Backspace: { code: 'Backspace', keyCode: 8 },
          Delete: { code: 'Delete', keyCode: 46 }, Space: { code: 'Space', keyCode: 32 },
          ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
          ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
          Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
          PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
        };
        const k = ${JSON.stringify(key)};
        const mapped = keyMap[k];
        const code = mapped ? mapped.code : (k.length === 1 ? 'Key' + k.toUpperCase() : k);
        const keyCode = mapped ? mapped.keyCode : (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
        const eventOpts = { key: k, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', eventOpts));
        el.dispatchEvent(new KeyboardEvent('keypress', eventOpts));
        // If Enter on an input/form element, try submitting the parent form
        if (k === 'Enter') {
          let form = el.closest ? el.closest('form') : null;
          if (!form) {
            let p = el; while (p && p.tagName !== 'FORM') p = p.parentElement;
            form = p;
          }
          if (form && typeof form.submit === 'function') {
            try { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch(_) {}
          }
        }
        el.dispatchEvent(new KeyboardEvent('keyup', eventOpts));
        return 'Pressed ${key}.';
      })()
    `);
  }, [evalInPage]);

  const uploadFile = useCallback(async (x: number | null, y: number | null, paths: string[]): Promise<string> => {
    // Read files as ArrayBuffer and transfer to the iframe context
    const fileDatas: { name: string; type: string; data: number[] }[] = [];
    for (const fp of paths) {
      try {
        const res = await fetch(`/api/fs/read-binary?path=${encodeURIComponent(fp)}`);
        if (!res.ok) return `Cannot read file: ${fp} (HTTP ${res.status})`;
        const blob = await res.blob();
        const buf = await blob.arrayBuffer();
        const name = fp.split(/[/\\]/).pop() || "file";
        fileDatas.push({ name, type: blob.type || "application/octet-stream", data: Array.from(new Uint8Array(buf)) });
      } catch { return `Cannot read file: ${fp}`; }
    }
    const serialized = JSON.stringify(fileDatas);
    const hitExpr = x != null && y != null
      ? (() => { const { x: vx, y: vy } = scaleToViewport(x, y); return `(document.elementFromPoint(${vx}, ${vy}) || null)`; })()
      : "null";
    return evalInPage(`
      (() => {
        let el = ${hitExpr};
        if (el) {
          el = el.closest ? (el.closest('input[type="file"]') || (el.tagName === 'INPUT' && el.type === 'file' ? el : null)) : null;
        }
        if (!el) {
          el = document.querySelector('input[type="file"]');
        }
        if (!el) return 'No file input found. Re-screenshot and click on the file input, or pass its coordinates.';

        const fileDatas = ${serialized};
        const dt = new DataTransfer();
        for (const fd of fileDatas) {
          const bytes = new Uint8Array(fd.data);
          const blob = new Blob([bytes], { type: fd.type });
          const file = new File([blob], fd.name, { type: fd.type });
          dt.items.add(file);
        }
        // Use native setter for React compatibility (React overrides HTMLInputElement.files)
        try {
          const nativeFilesSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'files'
          );
          if (nativeFilesSetter && nativeFilesSetter.set) {
            nativeFilesSetter.set.call(el, dt.files);
          } else {
            el.files = dt.files;
          }
        } catch(_) {
          el.files = dt.files;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'Uploaded ${paths.length} file(s).';
      })()
    `);
  }, [evalInPage, scaleToViewport]);

  const selectOption = useCallback(async (x: number, y: number, value?: string, label?: string): Promise<string> => {
    const { x: vx, y: vy } = scaleToViewport(x, y);
    const c = lastCaptureRef.current;
    const priorScale = c && c.imageW > 0 && c.viewportW > 0 ? c.viewportW / c.imageW : 1;
    const v = value != null ? JSON.stringify(value) : "null";
    const l = label != null ? JSON.stringify(label) : "null";
    return evalInPage(`
      (() => {
        ${PAGE_TARGET_HELPERS}
        const res = hResolveTarget(${vx}, ${vy}, ${priorScale});
        const el = res.el;
        if (el.tagName !== 'SELECT') return 'no <select> near (' + ${vx} + ',' + ${vy} + ') — found ' + hElLabel(el) + '. For custom dropdowns (not native <select>), use browser_click on the trigger, wait, then screenshot and browser_click the desired option.';
        const sel = el;

        // Click to activate — enhanced properties for framework compatibility
        const rect = sel.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const vx = Math.max(0, Math.min(cx, window.innerWidth - 1));
        const vy = Math.max(0, Math.min(cy, window.innerHeight - 1));
        const mouseOpts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
        const ptrOpts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, view: window };
        sel.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
        sel.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        sel.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
        sel.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        sel.dispatchEvent(new MouseEvent('click', mouseOpts));
        try { sel.focus(); } catch(_) {}

        const value = ${v};
        const label = ${l};
        let changed = false;
        if (value !== null) {
          if (sel.value !== value) { sel.value = value; changed = true; }
        } else if (label !== null) {
          // Try exact match first, then case-insensitive match
          for (let j = 0; j < sel.options.length; j++) {
            if (sel.options[j].text.trim() === label.trim()) {
              if (sel.selectedIndex !== j) { sel.selectedIndex = j; changed = true; }
              break;
            }
          }
          if (!changed) {
            // Case-insensitive fallback
            for (let j = 0; j < sel.options.length; j++) {
              if (sel.options[j].text.trim().toLowerCase() === label.trim().toLowerCase()) {
                sel.selectedIndex = j;
                changed = true;
                break;
              }
            }
          }
        }
        if (!changed) {
          const optList = Array.from(sel.options).slice(0, 10).map(function(o) { return o.value + ':"' + o.text.slice(0,40) + '"'; }).join(', ');
          return 'Option not found. Available options: ' + optList;
        }
        // Dispatch both input and change — some frameworks listen for 'input' on select
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'Selected: ' + (sel.options[sel.selectedIndex]?.text || sel.value);
      })()
    `);
  }, [evalInPage, scaleToViewport]);

  useImperativeHandle(ref, () => ({
    evalInPage, typeIntoElement, clearElement, clickCoords, moveMouse, rightClick, scrollPage, pressKey, uploadFile, getScreenshotHeader, captureScreenshotImage, navigateTo,
    waitForElement, getConsoleEntries, getRequestErrors, getInfo, selectOption,
  }), [evalInPage, typeIntoElement, clearElement, clickCoords, moveMouse, rightClick, scrollPage, pressKey, uploadFile, getScreenshotHeader, captureScreenshotImage, navigateTo,
    waitForElement, getConsoleEntries, getRequestErrors, getInfo, selectOption]);

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
        <button className="browser-btn" onClick={goBack} title="Back" disabled={!canGoBack}>◀</button>
        <button className="browser-btn" onClick={goForward} title="Forward" disabled={!canGoForward}>▶</button>
        {loading ? (
          <button className="browser-btn browser-btn-spinner" title="Loading..." disabled>
            <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: "h-spin 0.8s linear infinite" }}>
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="24 10" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <button className="browser-btn" onClick={refresh} title="Refresh">↻</button>
        )}
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
            ref={inputRef}
            className="browser-url-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { inputFocusedRef.current = true; }}
            onBlur={() => { inputFocusedRef.current = false; }}
            onClick={(e) => (e.target as HTMLInputElement).select()}
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
        <button
          className={`browser-btn browser-btn-mouse${inspectMode ? " active" : ""}`}
          onClick={toggleInspect}
          title={inspectMode ? "Exit inspect mode" : "Select an element to inspect"}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 1L3 11.5L5.9 8.6L8.3 14L10.1 13.2L7.7 7.4L11.5 7.4L3 1Z" fill="currentColor"/>
          </svg>
        </button>
        <button
          className="browser-btn"
          onClick={toggleDevtools}
          title="Open Browser Console"
        >
          🔧
        </button>
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
                  preload={window.hDesktop?.browserPreloadUrl}
                  partition="h-browser"
                  style={{ width: "100%", height: "100%" }}
                />
              ) : (
                <iframe
                  ref={setupIframe}
                  key={`${tabId}-${perms.geolocation}-${perms.camera}-${perms.microphone}`}
                  src={toProxySrc(currentUrl)}
                  allow={allowAttr}
                  sandbox={sandboxAttr}
                  onLoad={iframeLoadHandler}
                  style={{ width: "100%", height: "100%", border: "none" }}
                />
              )}
              {pageError && (
                <div style={{
                  position: "absolute", inset: 0, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  background: "rgba(20,20,20,0.95)", color: "#ccc", zIndex: 10,
                  fontFamily: "var(--mono-font, monospace)", fontSize: 12, padding: 24,
                }}>
                  <div style={{ color: "#e1251b", fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Page Load Error</div>
                  <div style={{ textAlign: "center", maxWidth: 500, lineHeight: 1.5 }}>{pageError}</div>
                  <button
                    onClick={() => setPageError(null)}
                    style={{
                      marginTop: 16, padding: "6px 16px", background: "rgba(255,255,255,0.1)",
                      border: "1px solid rgba(255,255,255,0.2)", borderRadius: 3,
                      color: "#ccc", cursor: "pointer", fontSize: 12,
                    }}
                  >
                    Dismiss
                  </button>
                </div>
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
});
