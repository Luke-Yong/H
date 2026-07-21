import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import os from "os";
import path from "path";

const EXPRESS_PORT_FILE = path.join(os.homedir(), ".harness", "express-port");
const VITE_PORT_FILE = path.join(os.homedir(), ".harness", "vite-port");

async function isExpressLive(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForExpressPort(timeoutMs = 30_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const val = parseInt(fs.readFileSync(EXPRESS_PORT_FILE, "utf8").trim(), 10);
      if (val > 0) {
        // Verify Express is actually alive on this port — not a stale file
        if (await isExpressLive(val)) return val;
        // Stale file — remove it so we don't loop on it
        try { fs.unlinkSync(EXPRESS_PORT_FILE); } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for Express server");
}

function writeVitePortPlugin() {
  return {
    name: "harness-write-vite-port",
    configureServer(server: any) {
      server.httpServer?.once("listening", () => {
        try {
          const dir = path.join(os.homedir(), ".harness");
          fs.mkdirSync(dir, { recursive: true });
          const addr = server.httpServer.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          if (port) fs.writeFileSync(VITE_PORT_FILE, String(port));
        } catch {}
      });
    },
  };
}

const expressPort = await waitForExpressPort();

export default defineConfig({
  plugins: [react(), writeVitePortPlugin()],
  server: {
    port: 0,
    proxy: {
      "/api": `http://localhost:${expressPort}`,
      "/ws": { target: `ws://localhost:${expressPort}`, ws: true },
      "/_browser": `http://localhost:${expressPort}`,
    },
  },
});
