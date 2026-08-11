import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import type { ViteDevServer } from "vite";

const PORTS_DIR = path.join(os.tmpdir(), "h-ports");
const EXPRESS_PORT_FILE = path.join(PORTS_DIR, "express-port");
const VITE_PORT_FILE = path.join(PORTS_DIR, "vite-port");

function readExpressPort(): number {
  try {
    const val = parseInt(fs.readFileSync(EXPRESS_PORT_FILE, "utf8").trim(), 10);
    return val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

// Cached Express port, validated lazily on each request until live.
let _cachedPort = 0;

function getExpressPort(): number {
  if (_cachedPort > 0) return _cachedPort;
  const p = readExpressPort();
  if (p > 0) _cachedPort = p;
  return _cachedPort;
}

function proxyRequest(req: IncomingMessage, res: ServerResponse) {
  const port = getExpressPort();
  if (!port) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Express server not ready" }));
    return;
  }

  // Remove hop-by-hop headers that Node re-adds
  const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
  delete headers.host;

  const options: http.RequestOptions = {
    hostname: "localhost",
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
    // Express may have restarted — invalidate cache
    _cachedPort = 0;
    if (!res.headersSent && !res.destroyed) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Express unreachable" }));
    }
  });

  // Client disconnected — abort the upstream request
  res.on("close", () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  // Suppress ECONNABORTED / ECONNRESET on client socket
  req.on("error", () => {});
  res.on("error", () => {});

  req.pipe(proxyReq);
}

function hProxyPlugin() {
  return {
    name: "h-proxy",
    configureServer(server: ViteDevServer) {
      // HTTP proxy for /api and /_browser — use req.url directly
      // (Connect's use("/api", ...) strips the prefix, breaking forwarding)
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api") || req.url?.startsWith("/_browser") || req.url === "/settings" || req.url === "/resources") {
          proxyRequest(req, res);
        } else {
          next();
        }
      });

      // WebSocket proxy for /ws
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/ws")) return;
        const port = getExpressPort();
        if (!port) { socket.destroy(); return; }

        const wsHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
        delete wsHeaders.host;

        const options: http.RequestOptions = {
          hostname: "localhost",
          port,
          path: req.url,
          method: req.method,
          headers: wsHeaders,
        };

        // Suppress errors on both sockets
        socket.on("error", () => {});
        req.on("error", () => {});

        const wsReq = http.request(options);
        wsReq.on("upgrade", (wsRes, wsSocket, wsHead) => {
          wsSocket.on("error", () => {});
          // Client left before we could upgrade — clean up
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
        // Client disconnected — abort proxy
        socket.on("close", () => { wsReq.destroy(); });
        wsReq.end();
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
