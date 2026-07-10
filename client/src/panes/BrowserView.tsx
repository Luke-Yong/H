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
  /** Get the DOM as indexed clickable elements. */
  getIndexedDom: () => Promise<string>;
  /** Click element at index (from getIndexedDom). */
  clickElement: (index: number) => Promise<string>;
  /** Type text into element at index using realistic keyboard events. */
  typeIntoElement: (index: number, text: string) => Promise<string>;
  /** Get a text snapshot of the page: URL, title, visible text, form elements, buttons. */
  getPageSnapshot: () => Promise<string>;
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
  /** Select an option in a <select> element by value or label. */
  selectOption: (index: number, value?: string, label?: string) => Promise<string>;
  /** Clear an input element at the given DOM index. */
  clearElement: (index: number) => Promise<string>;
  /** Left-click at viewport coordinates. */
  clickCoords: (x: number, y: number) => Promise<string>;
  /** Move mouse to viewport coordinates (triggers hover effects). */
  moveMouse: (x: number, y: number) => Promise<string>;
  /** Right-click at viewport coordinates (opens context menu). */
  rightClick: (x: number, y: number) => Promise<string>;
  /** Right-click element at DOM index. */
  rightClickElement: (index: number) => Promise<string>;
  /** Scroll the page. */
  scrollPage: (x: number, y: number, to?: string) => Promise<string>;
  /** Press a keyboard key. */
  pressKey: (key: string) => Promise<string>;
  /** Upload files to a file input. */
  uploadFile: (index: number, paths: string[]) => Promise<string>;
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

const DOM_INDEXING_HELPERS = String.raw`
const HARNESS_BUCKET_ORDER = ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'];
const harnessNormalizeText = (value, maxLen) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return typeof maxLen === 'number' && maxLen > 0 && text.length > maxLen ? text.slice(0, maxLen) : text;
};
const harnessQuoteText = (value, maxLen) => '"' + harnessNormalizeText(value, maxLen).replace(/"/g, "'") + '"';
const harnessInViewport = (r, vw, vh) => !(r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw);
const harnessIsCollapsed = (el) => {
  if (!el || el.nodeType !== 1) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return true;
  if (el.getAttribute('aria-expanded') === 'false' && !harnessPrimaryLabel(el)) return true;
  let cur = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (cur.hasAttribute && (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('inert'))) return true;
    if (cur.tagName && cur.tagName.toLowerCase() === 'details' && !cur.open) {
      let summary = null;
      try { summary = cur.querySelector(':scope > summary'); } catch (_) { summary = cur.querySelector('summary'); }
      if (!summary || (el !== summary && !summary.contains(el))) return true;
    }
    try {
      const cs = window.getComputedStyle(cur);
      if (
        cs.display === 'none'
        || cs.visibility === 'hidden'
        || cs.contentVisibility === 'hidden'
        || Number(cs.opacity || '1') < 0.05
        || cs.maxHeight === '0px'
      ) return true;
      if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && Number.parseFloat(cs.maxHeight || '0') === 0) return true;
    } catch (_) {}
    cur = cur.parentElement;
  }
  return false;
};
const harnessSamplePoints = (r, vw, vh) => {
  const padX = Math.max(1, Math.min(6, r.width / 4));
  const padY = Math.max(1, Math.min(6, r.height / 4));
  const clampX = (v) => Math.max(0, Math.min(v, Math.max(0, vw - 1)));
  const clampY = (v) => Math.max(0, Math.min(v, Math.max(0, vh - 1)));
  return [
    [clampX(r.left + r.width / 2), clampY(r.top + r.height / 2)],
    [clampX(r.left + padX), clampY(r.top + padY)],
    [clampX(r.right - padX), clampY(r.top + padY)],
    [clampX(r.left + padX), clampY(r.bottom - padY)],
    [clampX(r.right - padX), clampY(r.bottom - padY)],
  ];
};
const harnessIsOccluded = (el, r, vw, vh) => {
  if (r.width < 2 || r.height < 2) return true;
  const samples = harnessSamplePoints(r, vw, vh);
  let visibleHits = 0;
  for (let i = 0; i < samples.length; i++) {
    const pt = samples[i];
    const topEl = document.elementFromPoint(pt[0], pt[1]);
    if (!topEl) continue;
    if (topEl === el || el.contains(topEl) || topEl.contains(el)) {
      visibleHits++;
      if (visibleHits > 0) return false;
    }
  }
  return true;
};
const harnessPosKey = (r, vw, vh) => {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const ry = cy / Math.max(vh, 1);
  const rx = cx / Math.max(vw, 1);
  const row = ry < 0.33 ? 'T' : (ry < 0.66 ? 'M' : 'B');
  const col = rx < 0.33 ? 'L' : (rx < 0.66 ? 'C' : 'R');
  return row + col;
};
const harnessPosLabel = (k) => {
  if (k === 'TL') return 'Top-Left';
  if (k === 'TC') return 'Top-Center';
  if (k === 'TR') return 'Top-Right';
  if (k === 'ML') return 'Middle-Left';
  if (k === 'MC') return 'Middle-Center';
  if (k === 'MR') return 'Middle-Right';
  if (k === 'BL') return 'Bottom-Left';
  if (k === 'BC') return 'Bottom-Center';
  if (k === 'BR') return 'Bottom-Right';
  return k;
};
const harnessPrimaryLabel = (el) => {
  const tag = el.tagName.toLowerCase();
  const candidates = [];
  const push = (value) => {
    const text = harnessNormalizeText(value, 80);
    if (text) candidates.push(text);
  };
  push(el.getAttribute('aria-label'));
  push(el.getAttribute('title'));
  if (typeof el.labels !== 'undefined' && el.labels) {
    for (let i = 0; i < el.labels.length; i++) push(el.labels[i].textContent);
  }
  if (el.id) {
    try {
      const escaped = window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(el.id) : el.id;
      const label = document.querySelector('label[for="' + escaped + '"]');
      if (label) push(label.textContent);
    } catch (_) {}
  }
  if (tag === 'input') {
    push(el.placeholder);
    push(el.name);
    push(el.value);
  } else if (tag === 'textarea') {
    push(el.placeholder);
    push(el.name);
    push(el.value);
  } else if (tag === 'select') {
    const selIdx = typeof el.selectedIndex === 'number' && el.selectedIndex >= 0 ? el.selectedIndex : 0;
    push(el.options && el.options[selIdx] ? el.options[selIdx].text : '');
    push(el.value);
  } else if (tag === 'img') {
    push(el.alt);
  } else if (tag === 'a' && el.href) {
    push(el.textContent);
    push(el.href);
  } else {
    push(el.textContent);
  }
  return candidates[0] || '';
};
const harnessAncestorContext = (el) => {
  const parts = [];
  let cur = el.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && cur !== document.documentElement && depth < 6 && parts.length < 2) {
    const tag = cur.tagName.toLowerCase();
    const role = (cur.getAttribute('role') || '').toLowerCase();
    const id = cur.id ? '#' + cur.id : '';
    const cls = cur.className && typeof cur.className === 'string'
      ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      : '';
    const classPart = cls ? '.' + cls : '';
    const marker = [tag, role, id, cls].join(' ');
    const interestingTag = /^(form|dialog|section|article|aside|nav|main|header|footer|table|tr|li|ul|ol|fieldset)$/i.test(tag);
    const interestingRole = /^(dialog|form|navigation|main|region|complementary|banner|tabpanel|tablist|listbox|menu|grid|row|toolbar|list|listitem)$/i.test(role);
    const interestingClass = /(modal|dialog|drawer|panel|card|form|menu|nav|toolbar|sidebar|content|table|row|list|grid|section)/i.test(marker);
    if (interestingTag || interestingRole || interestingClass || cur.getAttribute('aria-label')) {
      const label = harnessPrimaryLabel(cur);
      parts.push((tag + id + classPart) + (label ? ' ' + harnessQuoteText(label, 50) : ''));
    }
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' <= ');
};
const harnessActionableRank = (el) => {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return -1;
  if (tag === 'input' && String(el.type || '').toLowerCase() === 'hidden') return -1;
  if (harnessIsCollapsed(el)) return -1;
  try {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return -1;
  } catch (_) {}
  let rank = 0;
  if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') rank = 6;
  else if (tag === 'input') rank = 6;
  else if (tag === 'a' && (el.href || harnessPrimaryLabel(el))) rank = 5;
  else if (tag === 'label' && (el.getAttribute('for') || el.control)) rank = 5;
  else if (/^(button|link|tab|menuitem|option|checkbox|radio|switch|textbox|combobox|listbox|slider|spinbutton)$/.test(role)) rank = 5;
  else if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') rank = 5;
  if (el.onclick || el.getAttribute('onclick')) rank = Math.max(rank, 4);
  const tabIdx = el.getAttribute('tabindex');
  if (tabIdx !== null && Number(tabIdx) >= 0) rank = Math.max(rank, 3);
  try {
    const cs = window.getComputedStyle(el);
    if (cs.cursor === 'pointer') rank = Math.max(rank, 3);
  } catch (_) {}
  return rank;
};
const harnessShouldInclude = (el, actionable, label) => {
  if (actionable) return true;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  if (role) return true;
  if (tag === 'img' || tag === 'label' || /^h[1-6]$/.test(tag)) return true;
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'a') return true;
  if (label) return true;
  if (el.id) return true;
  return false;
};
const harnessCollectItems = (options) => {
  const opts = options || {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const actionableFirst = opts.actionableFirst !== false;
  const actionableOnly = !!opts.actionableOnly;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const items = [];
  let domIdx = 0;
  let el;
  while ((el = w.nextNode())) {
    const r = el.getBoundingClientRect();
    if (!harnessInViewport(r, vw, vh)) {
      domIdx++;
      continue;
    }
    if (harnessIsCollapsed(el) || harnessIsOccluded(el, r, vw, vh)) {
      domIdx++;
      continue;
    }
    const actionableRank = harnessActionableRank(el);
    const actionable = actionableRank > 0;
    const label = harnessPrimaryLabel(el);
    if (actionableOnly && !actionable) {
      domIdx++;
      continue;
    }
    if (!harnessShouldInclude(el, actionable, label)) {
      domIdx++;
      continue;
    }
    items.push({
      el,
      r,
      domIdx,
      actionable,
      actionableRank,
      pk: harnessPosKey(r, vw, vh),
      label,
      ancestor: harnessAncestorContext(el),
    });
    domIdx++;
  }
  items.sort((a, b) => {
    if (actionableFirst && a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    if (actionableFirst && a.actionableRank !== b.actionableRank) return b.actionableRank - a.actionableRank;
    const dy = a.r.top - b.r.top;
    if (Math.abs(dy) > 0.5) return dy;
    const dx = a.r.left - b.r.left;
    if (Math.abs(dx) > 0.5) return dx;
    return a.domIdx - b.domIdx;
  });
  return { vw, vh, bucketOrder: HARNESS_BUCKET_ORDER, items };
};
`;

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
  const isDesktop = !!window.harnessDesktop?.isDesktop;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<BrowserGuest | null>(null);
  const webviewReadyRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputFocusedRef = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;

  // ── Browser reverse proxy (universal — all URLs proxied for same-origin iframe access) ──
  // Encodes a real URL into the server proxy URL format: /_browser?url=<encoded>
  const toProxySrc = useCallback((real: string): string => {
    if (!real) return real;
    return `/_browser?url=${encodeURIComponent(real)}`;
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
      // Sync display-only state (address bar) but do NOT touch navUrl/navTabId
      setCurrentUrl(url);
      setInputUrl(url);
      setSecure(isHttps(url));
      liveUrlRef.current = url;
      if (url) setLoading(true);
    } else {
      setNavTabId(tabId);
      setNavUrl(url);
      setCurrentUrl(url);
      setInputUrl(url);
      setSecure(isHttps(url));
      liveUrlRef.current = url;
      if (url) setLoading(true);
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
    // injectIntoIframe has __harnessPatched guard so repeated calls are safe
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
      if (!win.__harnessPatched) {
        win.__harnessPatched = true;
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
        if (!win.__harnessConsolePatched) {
          win.__harnessConsolePatched = true;
          win.__harnessConsoleEntries = [];

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
        win.__harnessConsoleEntries.push({ level, text, time: Date.now() });
        if (win.__harnessConsoleEntries.length > 500) win.__harnessConsoleEntries.shift();
        if (text.length > 2000) {
          let remaining = text, chunk = 0;
          while (remaining) {
            window.postMessage({ __harness: true, type: "console", level: level, text: remaining.substring(0, 2000), time: Date.now() }, "*");
            remaining = remaining.substring(2000); chunk++;
            if (chunk > 5) { window.postMessage({ __harness: true, type: "console", level: level, text: "...[truncated]", time: Date.now() }, "*"); break; }
          }
        } else {
          window.postMessage({ __harness: true, type: "console", level: level, text: text, time: Date.now() }, "*");
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
              __harness: true,
              type: "console",
              level: "error",
              text: `${msg}${source ? ` (${source}:${line}:${col})` : ""}`,
              source: source ? `${source}:${line}:${col}` : undefined,
              time: Date.now(),
            }, "*");
            if (origOnerror) origOnerror.call(win, msg, source, line, col);
          };

          // Intercept alert/confirm/prompt — log to console instead of blocking
          win.__harnessDialog = { lastText: "", lastResult: false };
          const origAlert = win.alert;
          win.alert = function(msg: any) {
            win.__harnessDialog.lastText = String(msg);
            postEntry("dialog", "[ALERT] " + String(msg));
          };
          const origConfirm = win.confirm;
          win.confirm = function(msg: any) {
            win.__harnessDialog.lastText = String(msg);
            win.__harnessDialog.lastResult = false;
            postEntry("dialog", "[CONFIRM] " + String(msg) + " → auto-dismissed as Cancel");
            return false;
          };
          const origPrompt = win.prompt;
          win.prompt = function(msg: any, def?: string) {
            win.__harnessDialog.lastText = String(msg);
            postEntry("dialog", "[PROMPT] " + String(msg) + " → auto-dismissed (default: " + (def || "") + ")");
            return def || "";
          };

          // PerformanceObserver: capture failed network requests (4xx/5xx/CORS)
          win.__harnessRequestErrors = [];
          try {
            const obs = new (win.PerformanceObserver)((list: any) => {
              for (const entry of list.getEntries()) {
                const e = entry as any;
                if (e.responseStatus && (e.responseStatus >= 400 || e.responseStatus === 0)) {
                  win.__harnessRequestErrors.push({
                    url: e.name,
                    method: 'fetch',
                    status: e.responseStatus,
                    type: e.initiatorType,
                    time: Date.now(),
                  });
                  if (win.__harnessRequestErrors.length > 200) win.__harnessRequestErrors.shift();
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
                win.__harnessRequestErrors.push({
                  url: typeof args[0] === 'string' ? args[0] : (args[0].url || 'unknown'),
                  method: (args[0].method || 'GET').toUpperCase(),
                  status: r.status,
                  type: 'fetch',
                  time: Date.now(),
                });
                if (win.__harnessRequestErrors.length > 200) win.__harnessRequestErrors.shift();
              }
              return r;
            }, function(err: any) {
              win.__harnessRequestErrors.push({
                url: typeof args[0] === 'string' ? args[0] : (args[0]?.url || 'unknown'),
                method: (args[0]?.method || 'GET').toUpperCase(),
                status: 0,
                type: 'fetch-error',
                time: Date.now(),
              });
              if (win.__harnessRequestErrors.length > 200) win.__harnessRequestErrors.shift();
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
          window.postMessage({ __harness: true, type: "domTree", nodes }, "*");
          const w = (iframe as HTMLIFrameElement).contentWindow as any;
          if (w && !w.__harnessHighlight) {
            w.__harnessHighlight = (targetUid: string) => {
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
    setLoading(false);
    injectIntoIframe(e.currentTarget);
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
      if (!e.data || !e.data.__harness) return;
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
        window.postMessage({ __harnessDevtools: true, type: "domTree", nodes: e.data.nodes }, "*");
      } else if (e.data.type === "hoverNode") {
        window.postMessage({ __harnessDevtools: true, type: "hoverNode", uid: e.data.uid }, "*");
      } else if (e.data.type === "inspectNode") {
        window.postMessage({ __harnessDevtools: true, type: "inspectNode", uid: e.data.uid }, "*");
      } else if (e.data.type === "highlight") {
        if (isDesktop) {
          const view = webviewRef.current;
          if (view) {
            void view.executeJavaScript?.("window.__harnessHighlight?.('"+String(e.data.uid).replace(/'/g,"\\'")+"')", false).catch(() => {});
          }
        } else if (iframeRef.current?.contentWindow) {
          (iframeRef.current.contentWindow as any).__harnessHighlight?.(e.data.uid);
        }
      } else if (e.data.type === "toggle-inspect") {
        setInspectMode(!!e.data.active);
        // Sync inspect state to TerminalPane
        window.postMessage({ __harnessDevtools: true, type: "inspectState", active: !!e.data.active }, "*");
        if (isDesktop) {
          const view = webviewRef.current;
          if (view) {
            if (e.data.active) {
              void view.executeJavaScript?.(`
                window.__harnessInspectorActive=true;
                (function(){
                  var s=document.createElement('style');s.id='__harness_inspect_style';
                  s.textContent='*{cursor:default!important}a,button,input,select,textarea,[onclick]{pointer-events:auto!important}';
                  document.head.appendChild(s);
                  function block(ev){if(window.__harnessInspectorActive){ev.preventDefault();ev.stopPropagation()}}
                  ['mousedown','mouseup','keydown','keypress','submit','focus','auxclick','dblclick','contextmenu'].forEach(function(n){document.addEventListener(n,block,true)});
                  window.__harnessInspectBlocker=block;
                })()
              `, false).catch(() => {});
            } else {
              void view.executeJavaScript?.(`
                window.__harnessInspectorActive=false;
                var l=window.__harnessLastEl;if(l&&l.style){l.style.outline=''}window.__harnessLastEl=null;
                var ib=document.getElementById('__harness_inspector_info');if(ib)ib.style.display='none';
                var ss=document.getElementById('__harness_inspect_style');if(ss)ss.remove();
                if(window.__harnessInspectBlocker){
                  var b=window.__harnessInspectBlocker;
                  ['mousedown','mouseup','keydown','keypress','submit','focus','auxclick','dblclick','contextmenu'].forEach(function(n){document.removeEventListener(n,b,true)});
                  delete window.__harnessInspectBlocker;
                }
              `, false).catch(() => {});
              window.postMessage({ __harnessDevtools: true, type: "inspectEnd" }, "*");
            }
          }
        } else if (iframeRef.current?.contentWindow) {
          if (e.data.active) {
            injectInspectorRef.current?.(iframeRef.current);
          } else {
            (iframeRef.current.contentWindow as any).__harnessInspectorCleanup?.();
            window.postMessage({ __harnessDevtools: true, type: "inspectEnd" }, "*");
          }
        }
        if (!e.data.active) {
          window.postMessage({ __harnessDevtools: true, type: "inspectEnd" }, "*");
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
              window.postMessage({ __harness: true, type: "domTree", nodes }, "*");
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
      window.postMessage({ __harness: true, type: "toggle-inspect", active: false }, "*");
    }
    // Clear old tab's DOM tree from TerminalPane immediately
    window.postMessage({ __harnessDevtools: true, type: "domTree", nodes: [] }, "*");
    // Immediately request fresh tree for the new tab
    window.postMessage({ __harness: true, type: "requestRefresh" }, "*");
  }, [tabId]);

  const syncDesktopState = useCallback((reason: string) => {
    const view = webviewRef.current;
    if (!view || !tabId) return;

    let nextUrl = liveUrlRef.current;
    try {
      nextUrl = view.getURL?.() || liveUrlRef.current;
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
      if(window.__harnessPatched)return;window.__harnessPatched=true;
      // Signal parent when DOM structure changes (parent reads tree via executeJavaScript)
      var _t=null;
      try{
        var mo=new MutationObserver(function(){clearTimeout(_t);_t=setTimeout(function(){console.log('[Harness:domChanged]')},150)});
        mo.observe(document.body,{childList:true,subtree:true});
      }catch(e){}
      console.log('[Harness:domChanged]');
      // Highlight function for tree→page sync
      window.__harnessHighlight=function(uid){
        var el=document.querySelector('[data-__huid="'+uid.replace(/"/g,'\\"')+'"]');
        if(el){
          el.style.outline='2px solid #4ec94e';el.style.outlineOffset='-1px';
          el.scrollIntoView({block:'nearest',behavior:'smooth'});
          setTimeout(function(){el.style.outline='';el.style.outlineOffset=''},2000);
        }
      };
      // Hover/click handlers for inspect mode
      var infoBar=document.createElement('div');
      infoBar.id='__harness_inspector_info';
      infoBar.style.cssText='position:fixed;bottom:4px;left:4px;max-width:calc(100vw - 8px);min-height:20px;max-height:42px;background:rgba(30,30,30,0.95);color:#ccc;font:10.5px/1.3 monospace;border-radius:3px;z-index:2147483647;padding:2px 6px;display:none;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      document.body.appendChild(infoBar);
      window.__harnessLastEl=null;
      document.addEventListener('mouseover',function(e){
        if(!window.__harnessInspectorActive)return;
        var t=e.target;
        if(!t||t===document.body||t===document.documentElement||t===infoBar)return;
        if(window.__harnessLastEl&&window.__harnessLastEl!==t){try{window.__harnessLastEl.style.outline=''}catch(x){}}
        try{t.style.outline='2px solid #4ec94e';t.style.outlineOffset='-1px'}catch(x){}
        window.__harnessLastEl=t;
        // Walk up to find closest ancestor with data-__huid
        var el=t;while(el&&el!==document.body&&el!==document.documentElement){var uid=el.getAttribute('data-__huid');if(uid){console.log('[Harness:domNode] '+uid);break}el=el.parentElement}
        var tag=t.tagName.toLowerCase();
        var tid=t.id?'#'+t.id:'';
        var tcls=t.className&&typeof t.className==='string'?'.'+t.className.trim().split(/\s+/).filter(Boolean).join('.'):'';
        var rect=t.getBoundingClientRect();
        var cs=getComputedStyle(t);
        infoBar.style.display='block';
        infoBar.textContent='<'+tag+tid+tcls+'>  '+rect.width.toFixed(0)+'\xD7'+rect.height.toFixed(0)+' @ ('+rect.left.toFixed(0)+', '+rect.top.toFixed(0)+')  |  '+cs.display+' | '+cs.position+(cs.position!=='static'?' ('+cs.top+','+cs.left+')':'')+'  |  color:'+cs.color+' bg:'+cs.backgroundColor;
      },true);
      document.addEventListener('click',function(e){
        if(!window.__harnessInspectorActive)return;
        e.preventDefault();e.stopPropagation();
        var t=e.target;
        // Walk up to find closest ancestor with data-__huid
        var el=t;var uid=null;while(el&&el!==document.body&&el!==document.documentElement){uid=el.getAttribute('data-__huid');if(uid)break;el=el.parentElement}
        if(uid){
          var tag=(el||t).tagName.toLowerCase();
          var id=(el||t).id?'#'+(el||t).id:'';
          var rect=(el||t).getBoundingClientRect();
          console.log('[Harness:inspectInfo] <'+tag+id+'>  '+rect.width.toFixed(0)+'\xD7'+rect.height.toFixed(0));
          console.log('[Harness:inspectNode] '+uid);
        }
        window.__harnessInspectorActive=false;
        if(window.__harnessLastEl){try{window.__harnessLastEl.style.outline=''}catch(x){}window.__harnessLastEl=null;}
        infoBar.style.display='none';
        // Clean up inspect styles + blockers
        var ss=document.getElementById('__harness_inspect_style');if(ss)ss.remove();
        if(window.__harnessInspectBlocker){var b=window.__harnessInspectBlocker;['mousedown','mouseup','keydown','keypress','submit','focus','auxclick','dblclick','contextmenu'].forEach(function(n){document.removeEventListener(n,b,true)});delete window.__harnessInspectBlocker}
        console.log('[Harness:inspectEnd] ');
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
        window.postMessage({ __harnessDevtools: true, type: "domTree", nodes }, "*");
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
      setLoading(false);
      syncDesktopState("did-finish-load");
      if (webviewReadyRef.current) {
        void view.executeJavaScript?.(DESKTOP_INJECT_CODE, false).catch(() => {});
        // Read final DOM state (injection may have been blocked by __harnessPatched guard,
        // but the tree may have changed since the last MutationObserver signal)
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
      void view.executeJavaScript?.(DESKTOP_INJECT_CODE, false).catch(() => {});
    };
    const handleDidFailLoad = () => { navigatingRef.current = false; setLoading(false); };
    const handleConsoleMessage = (event: Event) => {
      const details = event as Event & {
        level?: number;
        message?: string;
        line?: number;
        sourceId?: string;
      };
      const msg = details.message || "";

      // Internal signals from injected code — not forwarded as console entries
      if (msg.startsWith("[Harness:")) {
        if (msg === "[Harness:domChanged]") {
          // DOM structure changed — re-read the tree directly
          void readDesktopDomTree();
          return;
        }
        const match = msg.match(/^\[Harness:(domNode|inspectNode|inspectEnd|inspectInfo)\]\s*(.*)/s);
        if (match) {
          const kind = match[1];
          const text = match[2];
          if (kind === "domNode") {
            window.postMessage({ __harnessDevtools: true, type: "hoverNode", uid: text }, "*");
          } else if (kind === "inspectNode") {
            window.postMessage({ __harnessDevtools: true, type: "inspectNode", tagHint: text }, "*");
          } else if (kind === "inspectEnd") {
            setInspectMode(false);
            window.postMessage({ __harnessDevtools: true, type: "inspectEnd" }, "*");
            window.postMessage({ __harnessDevtools: true, type: "inspectState", active: false }, "*");
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
      if (details.channel === "harness:browserOpenUrl") {
        const popupUrl = typeof details.args?.[0] === "string" ? details.args[0] : "";
        if (popupUrl && popupUrl !== "about:blank") {
          onNewTabRef.current?.(popupUrl);
        }
      }
    };

    const handleStartLoading = () => { setLoading(true); };

    view.addEventListener("dom-ready", handleDomReady);
    view.addEventListener("did-start-loading", handleStartLoading);
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
      view.removeEventListener("did-start-loading", handleStartLoading);
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
    void window.harnessDesktop?.setSitePermissions?.(origin, { ...perms }).catch(() => {});
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
    setNavUrl(final);
    setCurrentUrl(final);
    setInputUrl(final);
    setSecure(isHttps(final));
    onUrlChange?.(tabId, final);

    // Explicit loadURL for desktop webview (src attribute update alone may not trigger navigation)
    if (isDesktop) {
      webviewRef.current?.loadURL?.(final);
    }
  }, [onUrlChange, tabId, isDesktop]);

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
    window.postMessage({ __harness: true, type: "toggle-inspect", active: next }, "*");
    if (next) {
      // Open terminal pane to browser console > elements
      onOpenDevtools?.();
      window.postMessage({ __harnessDevtools: true, type: "showElements" }, "*");
    }
  }, [inspectMode, onOpenDevtools]);

  // Inject element inspector into iframe on demand
  const injectInspector = useCallback((iframe: HTMLIFrameElement) => {
    try {
      const win = iframe.contentWindow as any;
      if (!win || win.__harnessInspectorActive) return;
      const doc = win.document;
      if (!doc || !doc.body) return;

      win.__harnessInspectorActive = true;
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
        window.postMessage({ __harness: true, type: "domTree", nodes }, "*");
      };

      // Highlight element by uid (tree→page hover)
      win.__harnessHighlight = (targetUid: string) => {
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
      inspectStyle.id = "__harness_inspect_style";
      inspectStyle.textContent = "*{cursor:default!important}";
      doc.head.appendChild(inspectStyle);
      const blockEvent = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
      const blockEvents = ["mousedown", "mouseup", "keydown", "keypress", "submit", "focus", "auxclick", "dblclick", "contextmenu"];
      blockEvents.forEach((n) => doc.addEventListener(n, blockEvent, true));

      // Info bar at bottom of viewport (multi-line tooltip)
      const infoBar = doc.createElement("div");
      infoBar.id = "__harness_inspector_info";
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
          if (uid) { window.postMessage({ __harness: true, type: "hoverNode", uid }, "*"); break; }
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
            __harness: true,
            type: "console",
            level: "info",
            text: "<" + tag + eid + ">  " + rect.width.toFixed(0) + "\xD7" + rect.height.toFixed(0),
            time: Date.now(),
            source: "inspect",
          }, "*");
          window.postMessage({ __harness: true, type: "inspectNode", uid }, "*");
        }
        // Turn off inspect
        win.__harnessInspectorCleanup?.();
        window.postMessage({ __harness: true, type: "toggle-inspect", active: false }, "*");
      };

      doc.addEventListener("mouseover", onMouseOver, true);
      doc.addEventListener("click", onClick, true);

      win.__harnessInspectorCleanup = () => {
        if (lastEl) (lastEl as HTMLElement).style.outline = "";
        infoBar.remove();
        inspectStyle.remove();
        blockEvents.forEach((n) => doc.removeEventListener(n, blockEvent, true));
        doc.removeEventListener("mouseover", onMouseOver, true);
        doc.removeEventListener("click", onClick, true);
        delete win.__harnessInspectorActive;
        delete win.__harnessInspectorCleanup;
        delete win.__harnessHighlight;
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
    setNavUrl(final);
    setCurrentUrl(final);
    setInputUrl(final);
    setSecure(isHttps(final));
    onUrlChange?.(tabId, final);

    if (isDesktop) {
      webviewRef.current?.loadURL?.(final);
    }

    // Blur the input after navigation
    e.currentTarget.blur();
  }, [tabId, isDesktop, onUrlChange]);

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
        const newUrl = wv ? (wv as any).getURL() : "";
        return fallback + (newUrl ? " (navigation triggered, now at " + newUrl + ")" : " (navigation triggered)");
      } catch {
        return fallback + " (navigation triggered)";
      }
    }
    return result;
  }, [getWebview]);

  const getIndexedDom = useCallback(async (): Promise<string> => {
    return evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const collected = harnessCollectItems({ actionableFirst: true });
        const vw = collected.vw, vh = collected.vh;
        const bucketOrder = collected.bucketOrder;
        const items = collected.items;
        const buckets = Object.create(null);
        for (const k of bucketOrder) buckets[k] = [];

        const lineFor = (item, i) => {
          const el = item.el;
          const r = item.r;
          const tag = el.tagName.toLowerCase();
          const elDesc = [];
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
          elDesc.push('<' + tag + id + cls + '>');
          if (item.actionable) elDesc.push('actionable');
          if (item.label) elDesc.push(harnessQuoteText(item.label, 60));

          const x = Math.round(r.left), y = Math.round(r.top);
          const rw = Math.round(r.width), rh = Math.round(r.height);
          elDesc.push('pos=' + item.pk);
          elDesc.push('(x:' + x + ' y:' + y + ' ' + rw + 'x' + rh + ')');
          if (item.ancestor) elDesc.push('within=' + harnessQuoteText(item.ancestor, 110));

          if (tag === 'a' && el.href) elDesc.push('href="' + el.href.slice(0, 60) + '"');
          if (tag === 'button') elDesc.push(el.disabled ? 'disabled' : 'clickable');
          if (tag === 'input') {
            const itype = el.type || 'text';
            const inpInfo = ['type=' + itype];
            if (el.name) inpInfo.push('name="' + el.name + '"');
            if (el.placeholder) inpInfo.push('placeholder="' + el.placeholder + '"');
            if (el.value) inpInfo.push('value="' + String(el.value).slice(0, 30) + '"');
            if (el.disabled) inpInfo.push('disabled');
            if (el.readOnly) inpInfo.push('readonly');
            if (itype === 'checkbox' || itype === 'radio') inpInfo.push(el.checked ? 'checked' : 'unchecked');
            elDesc.push(inpInfo.join(' '));
          }
          if (tag === 'select') {
            const selVal = el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
            elDesc.push('value="' + (selVal || el.value || '').slice(0, 30) + '"');
            if (el.disabled) elDesc.push('disabled');
          }
          if (tag === 'textarea') {
            if (el.name) elDesc.push('name="' + el.name + '"');
            if (el.placeholder) elDesc.push('placeholder="' + el.placeholder + '"');
            if (el.value) elDesc.push('value="' + String(el.value).slice(0, 30) + '"');
            if (el.disabled) elDesc.push('disabled');
          }
          if (tag === 'img') {
            if (el.alt) elDesc.push('alt="' + el.alt.slice(0, 40) + '"');
            if (el.src) elDesc.push('src="' + el.src.slice(0, 50) + '"');
          }

          const role = el.getAttribute('role');
          if (role) elDesc.push('role=' + role);
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) elDesc.push('aria-label="' + ariaLabel.slice(0, 40) + '"');
          const ariaExpanded = el.getAttribute('aria-expanded');
          if (ariaExpanded) elDesc.push('aria-expanded=' + ariaExpanded);
          const ariaSelected = el.getAttribute('aria-selected');
          if (ariaSelected) elDesc.push('aria-selected=' + ariaSelected);

          const tabIdx = el.getAttribute('tabindex');
          if (tabIdx !== null) elDesc.push('tabindex=' + tabIdx);

          for (let a = 0; a < el.attributes.length; a++) {
            const attr = el.attributes[a];
            if (attr.name.startsWith('data-')) {
              elDesc.push(attr.name + '="' + String(attr.value).slice(0, 30) + '"');
              if (elDesc.length > 12) break;
            }
          }

          try {
            const cs = window.getComputedStyle(el);
            if (cs.cursor === 'pointer') elDesc.push('cursor=pointer');
          } catch(_) {}

          return '[' + i + '] ' + elDesc.join(' ');
        };

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          (buckets[it.pk] || (buckets[it.pk] = [])).push(lineFor(it, i));
        }

        const out = [];
        out.push('viewport:' + vw + 'x' + vh);
        out.push('order: actionable elements first, then top-to-bottom then left-to-right (pos buckets TL..BR)');
        for (const k of bucketOrder) {
          const arr = buckets[k];
          if (!arr || arr.length === 0) continue;
          out.push('--- ' + harnessPosLabel(k) + ' (' + arr.length + ') ---');
          out.push(arr.join('\\n'));
        }
        return out.join('\\n');
      })()
    `);
  }, [evalInPage]);

  const clickElement = useCallback(async (index: number): Promise<string> => {
    const result = await evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const items = harnessCollectItems({ actionableFirst: true }).items;
        const target = items[${index}];
        if (!target || !target.el) return 'element not found at index ${index}';
        const rect = target.el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          // Constrain coords to viewport (avoid dispatching outside visible area)
          const vx = Math.max(0, Math.min(cx, window.innerWidth - 1));
          const vy = Math.max(0, Math.min(cy, window.innerHeight - 1));
          const mouseOpts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
          const ptrOpts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, view: window };
          // Try focusing — works for native focusable elements
          try { if (typeof target.el.focus === 'function') target.el.focus(); } catch(_) {}
          // Dispatch full mouse event sequence with enhanced properties
          target.el.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
          target.el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          target.el.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
          target.el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          target.el.dispatchEvent(new MouseEvent('click', mouseOpts));
          // Fallback: native click() for handlers that require isTrusted:true
          try { target.el.click(); } catch(_) {}
          return 'clicked <' + target.el.tagName.toLowerCase() + '> at index ${index}';
      })()
    `);
    // If the click triggered a page navigation (e.g. clicking a link/button that changes URL),
    // Electron's executeJavaScript throws GUEST_VIEW_MANAGER_CALL because the renderer
    // process is torn down mid-execution. The click did succeed — we report the new URL.
    const finalResult = await handleNavigationError(result, "clicked element at index " + index);
    if (result === finalResult) {
      // No navigation error — normal click, short wait for DOM updates
      await new Promise((r) => setTimeout(r, 400));
    }
    return finalResult;
  }, [evalInPage, handleNavigationError]);

  const typeIntoElement = useCallback(async (index: number, text: string) => {
    const result = await evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const items = harnessCollectItems({ actionableFirst: true }).items;
        const target = items[${index}];
        if (!target || !target.el) return 'element not found at index ${index}';
        const inp = target.el;

          // Click the element first — reactive frameworks (React/Vue) need real mouse events
          const rect = inp.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const vx = Math.max(0, Math.min(cx, window.innerWidth - 1));
          const vy = Math.max(0, Math.min(cy, window.innerHeight - 1));
          const mouseOpts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
          const ptrOpts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, view: window };
          inp.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
          inp.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          inp.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
          inp.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          inp.dispatchEvent(new MouseEvent('click', mouseOpts));
          try { inp.focus(); } catch(_) {}

          // Resolve the native value setter (React overrides HTMLInputElement.prototype.value)
          const nativeSetter = Object.getOwnPropertyDescriptor(
            (inp.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement).prototype, 'value'
          );
          const setValue = nativeSetter && nativeSetter.set
            ? function(v) { nativeSetter.set.call(inp, v); }
            : function(v) { inp.value = v; };

          // Select all, clear via native setter, notify frameworks
          if (typeof inp.select === 'function') inp.select();
          setValue('');
          inp.dispatchEvent(new Event('input', { bubbles: true }));

          if (!${JSON.stringify(text)}) {
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return 'cleared element at index ${index}';
          }

          // Type each character with native input events + native value setter
          for (const ch of ${JSON.stringify(text)}) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
            inp.dispatchEvent(new KeyboardEvent('keypress', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
            const start = inp.selectionStart || 0;
            const newVal = inp.value.slice(0, start) + ch + inp.value.slice(inp.selectionEnd || start);
            setValue(newVal);
            inp.selectionStart = inp.selectionEnd = start + 1;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
          }
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return 'typed "' + ${JSON.stringify(text)} + '" into ' + inp.tagName.toLowerCase() + ' at index ${index}';
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    return result;
  }, [evalInPage]);

  const getPageSnapshot = useCallback(async (): Promise<string> => {
    return evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const lines = [];
        lines.push('URL: ' + window.location.href);
        lines.push('Title: ' + document.title);
        const collected = harnessCollectItems({ actionableFirst: true });
        const vw = collected.vw, vh = collected.vh;
        const bucketOrder = collected.bucketOrder;
        const items = collected.items;
        lines.push('Viewport: ' + vw + 'x' + vh);

        const allBuckets = Object.create(null);
        const interactiveBuckets = Object.create(null);
        for (const k of bucketOrder) { allBuckets[k] = []; interactiveBuckets[k] = []; }

        for (let idx = 0; idx < items.length && idx < 500; idx++) {
          const it = items[idx];
          const el = it.el;
          const tag = el.tagName.toLowerCase();
          const id = it.el.id ? '#' + it.el.id : '';
          const label = harnessNormalizeText(it.label, 60);
          const markers = [];
          if (['h1','h2','h3','h4','h5','h6'].includes(tag)) markers.push(tag.toUpperCase());
          if (tag === 'img') markers.push('IMG');
          if (tag === 'li') markers.push('LI');
          if (tag === 'label') markers.push('LABEL');
          if (it.actionable) markers.push('ACTION');
          const marker = markers.length ? ' [' + markers.join('/') + ']' : '';
          const within = it.ancestor ? ' within=' + harnessQuoteText(it.ancestor, 80) : '';
          const shortDesc = '[' + idx + '] <' + tag + id + '>' + ' pos=' + it.pk + marker + (label ? ' ' + harnessQuoteText(label, 60) : '') + within;
          (allBuckets[it.pk] || (allBuckets[it.pk] = [])).push(shortDesc);
          if (it.actionable) (interactiveBuckets[it.pk] || (interactiveBuckets[it.pk] = [])).push(shortDesc);
        }

        const flatten = (buckets) => {
          const out = [];
          let total = 0;
          for (const k of bucketOrder) total += (buckets[k]?.length || 0);
          for (const k of bucketOrder) {
            const arr = buckets[k];
            if (!arr || arr.length === 0) continue;
            out.push('--- ' + harnessPosLabel(k) + ' (' + arr.length + ') ---');
            out.push(arr.join('\\n'));
          }
          return { out, total };
        };

        const interactiveFlat = flatten(interactiveBuckets);
        if (interactiveFlat.total > 0) {
          lines.push('--- Interactive (' + interactiveFlat.total + ', actionable-first) ---');
          lines.push(interactiveFlat.out.join('\\n'));
        }

        const allFlat = flatten(allBuckets);
        if (allFlat.total <= 200) {
          lines.push('--- All Elements (' + allFlat.total + ', actionable-first) ---');
          lines.push(allFlat.out.join('\\n'));
        } else {
          lines.push('--- All Elements: ' + allFlat.total + ' (actionable-first; use browser_get_dom for full listing) ---');
        }

        // Error state: visible error text
        const errors = document.querySelectorAll('[role="alert"], .error, .alert-danger, [class*="error"], [class*="Error"]');
        if (errors.length > 0) {
          lines.push('--- Errors/Warnings ---');
          errors.forEach(function(el) {
            const txt = (el.textContent || '').trim().slice(0, 200);
            if (txt) lines.push('  ' + txt);
          });
        }

        return lines.join('\\n');
      })()
    `);
  }, [evalInPage]);

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
        if (!window.__harnessConsoleEntries) return 'No console entries captured.';
        const entries = window.__harnessConsoleEntries.slice(-50);
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
        if (!window.__harnessRequestErrors || window.__harnessRequestErrors.length === 0) {
          return 'No request errors captured.';
        }
        const errors = window.__harnessRequestErrors.slice(-30);
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
      setNavTabId(activeTab.id);
      setNavUrl(url);
      setCurrentUrl(url);
      setInputUrl(url);
      setSecure(isHttps(url));
      onUrlChange?.(activeTab.id, url);
      // Explicit loadURL for desktop webview — src attribute update via React
      // alone may not trigger navigation if the URL string hasn't changed.
      if (isDesktop) {
        webviewRef.current?.loadURL?.(url);
      }
    }
  }, [activeTab, onUrlChange, isDesktop]);

  const getInfo = useCallback((): string => {
    if (!activeTab || !currentUrl) return "No browser tab open. Use browser_navigate to open a URL first.";
    return `URL: ${currentUrl} | Title: ${activeTab.label || "(no title)"} | Loaded: ${loading ? "loading" : "yes"} | Tabs: ${tabs.length}`;
  }, [activeTab, currentUrl, loading, tabs]);

  const clearElement = useCallback(async (index: number): Promise<string> => {
    const result = await typeIntoElement(index, "");
    // typeIntoElement returns "cleared element at index N" for empty text
    return result.startsWith("cleared") ? "Cleared element." : result;
  }, [typeIntoElement]);

  // ── Coordinate-based mouse ──
  // Uses enhanced event properties (pointerId, pointerType, button, buttons) so that
  // React/Vue and other frameworks properly recognize the synthetic events.
  const mouseEvent = useCallback(async (x: number, y: number, eventType: string): Promise<string> => {
    return evalInPage(`
      (() => {
        const el = document.elementFromPoint(${x}, ${y});
        const target = el || document.body;
        const mouseOpts = { clientX: ${x}, clientY: ${y}, screenX: ${x}, screenY: ${y}, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
        const pointerOpts = { clientX: ${x}, clientY: ${y}, screenX: ${x}, screenY: ${y}, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, view: window };
        if (${JSON.stringify(eventType)} === 'click') {
          target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
          target.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          target.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
          target.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          target.dispatchEvent(new MouseEvent('click', mouseOpts));
          // Fallback: native click() for handlers that require isTrusted
          try { target.click(); } catch(_) {}
        } else if (${JSON.stringify(eventType)} === 'contextmenu') {
          target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
          target.dispatchEvent(new MouseEvent('mousedown', { ...mouseOpts, button: 2, buttons: 2 }));
          target.dispatchEvent(new MouseEvent('contextmenu', mouseOpts));
          target.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, button: 2, buttons: 0 }));
        } else if (${JSON.stringify(eventType)} === 'move') {
          target.dispatchEvent(new MouseEvent('mousemove', mouseOpts));
          target.dispatchEvent(new PointerEvent('pointermove', pointerOpts));
        }
        const tag = target.tagName ? target.tagName.toLowerCase() : 'unknown';
        return ${JSON.stringify(eventType)} + ' at (' + ${x} + ',' + ${y} + ') on <' + tag + '>';
      })()
    `);
  }, [evalInPage]);

  const clickCoords = useCallback(async (x: number, y: number): Promise<string> => {
    const result = await mouseEvent(x, y, "click");
    return handleNavigationError(result, "click at (" + x + "," + y + ")");
  }, [mouseEvent, handleNavigationError]);

  const moveMouse = useCallback(async (x: number, y: number): Promise<string> => {
    return mouseEvent(x, y, "move");
  }, [mouseEvent]);

  const rightClick = useCallback(async (x: number, y: number): Promise<string> => {
    return mouseEvent(x, y, "contextmenu");
  }, [mouseEvent]);

  const rightClickElement = useCallback(async (index: number): Promise<string> => {
    return evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const items = harnessCollectItems({ actionableFirst: true }).items;
        const target = items[${index}];
        if (target && target.el) {
          const el = target.el;
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const vx = Math.max(0, Math.min(cx, window.innerWidth - 1));
          const vy = Math.max(0, Math.min(cy, window.innerHeight - 1));
          const opts = { clientX: vx, clientY: vy, screenX: vx, screenY: vy, bubbles: true, cancelable: true, button: 2, buttons: 2, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('contextmenu', opts));
          return 'right-clicked <' + el.tagName.toLowerCase() + '> at index ${index}';
        }
        return 'element not found at index ${index}';
      })()
    `);
  }, [evalInPage]);

  const scrollPage = useCallback(async (x: number, y: number, to?: string): Promise<string> => {
    if (to === "top") return evalInPage(`window.scrollTo(0, 0); 'Scrolled to top.';`);
    if (to === "bottom") return evalInPage(`window.scrollTo(0, document.body.scrollHeight); 'Scrolled to bottom.';`);
    return evalInPage(`window.scrollBy(${x || 0}, ${y || 0}); 'Scrolled by ${x || 0},${y || 0}.';`);
  }, [evalInPage]);

  const hoverElement = useCallback(async (index: number): Promise<string> => {
    return evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const items = harnessCollectItems({ actionableFirst: true }).items;
        const target = items[${index}];
        if (!target || !target.el) return 'Element not found at index ${index}.';
        const el = target.el;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: cx, clientY: cy }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
        return 'Hovered element at index ${index}.';
      })()
    `);
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

  const uploadFile = useCallback(async (index: number, paths: string[]): Promise<string> => {
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
    return evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const items = harnessCollectItems({ actionableFirst: true }).items;
        const target = items[${index}];
        if (!target || !target.el) return 'Element not found at index ${index}.';
        const el = target.el;
        if (el.tagName !== 'INPUT' || el.type !== 'file') return 'Element is not a file input.';

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
  }, [evalInPage]);

  const selectOption = useCallback(async (index: number, value?: string, label?: string): Promise<string> => {
    const v = value != null ? JSON.stringify(value) : "null";
    const l = label != null ? JSON.stringify(label) : "null";
    return evalInPage(`
      (() => {
        ${DOM_INDEXING_HELPERS}
        const items = harnessCollectItems({ actionableFirst: true }).items;
        const target = items[${index}];
        if (!target || !target.el) return 'Element not found at index ${index}.';
        const el = target.el;
        if (el.tagName !== 'SELECT') return 'Element at index ${index} is <' + el.tagName.toLowerCase() + '>, not a <select>. Tip: for custom dropdowns (not native <select>), use browser_click on the trigger, then browser_wait + browser_get_dom to find options, then browser_click on the desired option.';
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
  }, [evalInPage]);

  useImperativeHandle(ref, () => ({
    evalInPage, getIndexedDom, clickElement, typeIntoElement, clearElement, clickCoords, moveMouse, rightClick, rightClickElement, scrollPage, pressKey, uploadFile, getPageSnapshot, navigateTo,
    waitForElement, getConsoleEntries, getRequestErrors, getInfo, selectOption,
  }), [evalInPage, getIndexedDom, clickElement, typeIntoElement, clearElement, clickCoords, moveMouse, rightClick, rightClickElement, scrollPage, pressKey, uploadFile, getPageSnapshot, navigateTo,
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
            <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: "harness-spin 0.8s linear infinite" }}>
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
                  preload={window.harnessDesktop?.browserPreloadUrl}
                  partition="harness-browser"
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
