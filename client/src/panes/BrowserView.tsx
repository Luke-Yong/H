import { useRef, useEffect } from "react";
import type { LoopEvent } from "../../../server/loop";

interface Props {
  events: LoopEvent[];
}

export default function BrowserView({ events }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScreenshot = useRef<string | null>(null);

  // Keep only the latest screenshot
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "screenshot") {
      lastScreenshot.current = events[i].data as string;
      break;
    }
  }

  // Scroll any DOM preview to bottom
  useEffect(() => {
    if (containerRef.current) {
      const el = containerRef.current.querySelector(".browser-view");
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [lastScreenshot.current]);

  return (
    <div className="browser-view" ref={containerRef}>
      {lastScreenshot.current ? (
        <img
          src={`data:image/jpeg;base64,${lastScreenshot.current}`}
          alt="Browser preview"
        />
      ) : (
        <div className="browser-placeholder">
          Click <strong>Run Test</strong> to see the browser preview here.
        </div>
      )}
    </div>
  );
}
