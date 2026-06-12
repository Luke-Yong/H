import { useRef, useCallback, useState, useEffect } from "react";

interface Props {
  url: string;
}

function isUrlLike(input: string): boolean {
  if (!input.trim()) return false;
  if (/^https?:\/\//i.test(input)) return true;
  if (/^localhost/i.test(input)) return true;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(input)) return true;
  if (/^\[.*\]/.test(input)) return true;
  // Has a dot + no spaces → likely a domain
  if (input.includes(".") && !input.includes(" ")) return true;
  return false;
}

export default function BrowserView({ url }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inputUrl, setInputUrl] = useState(url);

  useEffect(() => { setCurrentUrl(url); setInputUrl(url); }, [url]);

  const navigate = useCallback(() => {
    const raw = inputUrl.trim();
    if (!raw) return;
    let final: string;
    if (isUrlLike(raw)) {
      final = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    } else {
      // Search with Bing
      final = `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
    }
    setCurrentUrl(final);
    setInputUrl(final);
  }, [inputUrl]);

  const refresh = useCallback(() => {
    iframeRef.current?.contentWindow?.location.reload();
  }, []);

  const goBack = useCallback(() => {
    iframeRef.current?.contentWindow?.history.back();
  }, []);

  const goForward = useCallback(() => {
    iframeRef.current?.contentWindow?.history.forward();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") navigate();
  }, [navigate]);

  return (
    <div className="browser-iframe-container">
      <div className="browser-toolbar">
        <button className="browser-btn" onClick={goBack} title="Back">◀</button>
        <button className="browser-btn" onClick={goForward} title="Forward">▶</button>
        <button className="browser-btn" onClick={refresh} title="Refresh">↻</button>
        <input
          className="browser-url-input"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search Bing or enter URL"
          spellCheck={false}
        />
        <button className="browser-btn browser-btn-go" onClick={navigate}>Go</button>
      </div>
      {currentUrl ? (
        <iframe
          ref={iframeRef}
          className="browser-iframe"
          src={currentUrl}
          allow="geolocation; microphone; camera; midi; encrypted-media; autoplay; downloads"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-downloads-without-user-activation allow-modals allow-orientation-lock allow-pointer-lock allow-presentation"
        />
      ) : (
        <div className="browser-placeholder">
          Enter a URL or search query in the address bar above.
        </div>
      )}
    </div>
  );
}
