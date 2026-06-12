import { useState, useEffect, useRef, useCallback } from "react";
import type { LoopEvent, LoopConfig } from "../../../server/loop";

const WS_URL =
  window.location.port === "5173"
    ? "ws://localhost:3001/ws"
    : `ws://${window.location.host}/ws`;

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setEvents([{ type: "log", data: "Connected to Harness server" }]);
    };

    ws.onmessage = (msg) => {
      try {
        const event: LoopEvent = JSON.parse(msg.data);
        setEvents((prev) => [...prev, event]);
      } catch {
        console.warn("Failed to parse WS message:", msg.data);
      }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    return () => ws.close();
  }, []);

  const runTest = useCallback(async (config: LoopConfig) => {
    setEvents([]);
    try {
      await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch (err) {
      setEvents((prev) => [
        ...prev,
        { type: "error", data: `Failed to start test: ${err}` },
      ]);
    }
  }, []);

  return { connected, events, runTest };
}
