import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import net from "net";
import type { IncomingMessage, ServerResponse } from "http";
import type { ViteDevServer } from "vite";

const PORTS_DIR = path.join(os.tmpdir(), "h-ports");
const VITE_PORT_FILE = path.join(PORTS_DIR, "vite-port");

// ── Fixed port range matching server/index.ts ──
const EXPRESS_DEFAULT_PORT = 51734;
const EXPRESS_PORT_RANGE = 20;

function probePort(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    let resolved = false;
    const done = (open: boolean) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroy(); } catch {}
      resolve(open);
    };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
    sock.on("close", () => done(false));
    try { sock.connect(port, host); } catch { done(false); }
  });
}

let _cachedExpressPort = 0;
let _cachedAt = 0;
const CACHE_TTL_MS = 3000;

async function findExpressPort(): Promise<number> {
  const now = Date.now();
  if (_cachedExpressPort > 0 && now - _cachedAt < CACHE_TTL_MS) return _cachedExpressPort;
  for (let i = 0; i < EXPRESS_PORT_RANGE; i++) {
    const p = EXPRESS_DEFAULT_PORT + i;
    const open = await probePort("127.0.0.1", p);
    if (open) {
      _cachedExpressPort = p;
      _cachedAt = now;
      return p;
    }
  }
  return 0;
}

function invalidateExpressPort() {
  _cachedExpressPort = 0;
  _cachedAt = 0;
}

function proxyRequest(req: IncomingMessage, res: ServerResponse) {
  findExpressPort().then((port) => {
    if (!port) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Express server not ready" }));
      return;
    }

    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    delete headers.host;

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 200;
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v) res.setHeader(k, v);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on("error", () => {
      invalidateExpressPort();
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Express unreachable" }));
      }
    });

    res.on("close", () => {
      if (!res.writableEnded) proxyReq.destroy();
    });

    req.on("error", () => {});
    res.on("error", () => {});

    req.pipe(proxyReq);
  }).catch(() => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Port probe failed" }));
  });
}

function hProxyPlugin() {
  return {
    name: "h-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api") || req.url?.startsWith("/_browser") || req.url === "/settings" || req.url === "/resources") {
          proxyRequest(req, res);
        } else {
          next();
        }
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/ws")) return;
        findExpressPort().then((port) => {
          if (!port) { socket.destroy(); return; }

          const wsHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
          delete wsHeaders.host;

          const options: http.RequestOptions = {
            hostname: "127.0.0.1",
            port,
            path: req.url,
            method: req.method,
            headers: wsHeaders,
          };

          socket.on("error", () => {});
          req.on("error", () => {});

          const wsReq = http.request(options);
          wsReq.on("upgrade", (wsRes, wsSocket, wsHead) => {
            wsSocket.on("error", () => {});
            if (socket.destroyed) { wsSocket.destroy(); return; }
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\n" +
              Object.entries(wsRes.headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\r\n") +
              "\r\n\r\n"
            );
            socket.write(wsHead);
            socket.pipe(wsSocket as any);
            (wsSocket as any).pipe(socket);
          });
          wsReq.on("error", () => { socket.destroy(); });
          socket.on("close", () => { wsReq.destroy(); });
          wsReq.end();
        }).catch(() => { socket.destroy(); });
      });
    },
  };
}

function writeVitePortPlugin() {
  return {
    name: "h-write-vite-port",
    configureServer(server: ViteDevServer) {
      server.httpServer?.once("listening", () => {
        try {
          fs.mkdirSync(PORTS_DIR, { recursive: true });
          const addr = server.httpServer!.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          if (port) fs.writeFileSync(VITE_PORT_FILE, String(port));
        } catch {}
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), hProxyPlugin(), writeVitePortPlugin()],
});
