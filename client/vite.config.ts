import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import os from "os";
import path from "path";

const PORT_FILE = path.join(os.homedir(), ".harness", "express-port");
const VITE_PORT_FILE = path.join(os.homedir(), ".harness", "vite-port");

function readExpressPort(): number {
  try {
    return parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10) || 5173;
  } catch {
    return 5173; // fallback — will retry on HMR if Express starts later
  }
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

export default defineConfig(async () => {
  const expressPort = readExpressPort();

  return {
    plugins: [react(), writeVitePortPlugin()],
    server: {
      port: 0,
      proxy: {
        "/api": `http://localhost:${expressPort}`,
        "/ws": { target: `ws://localhost:${expressPort}`, ws: true },
        "/_browser": `http://localhost:${expressPort}`,
      },
    },
  };
});
