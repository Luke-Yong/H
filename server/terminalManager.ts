import { spawn } from "child_process";
import { WebSocket } from "ws";
import fs from "fs";
import path from "path";
import os from "os";

type Backend = "pty" | "pipe";

// Detect localhost URLs in terminal output (e.g. Flask "Running on http://127.0.0.1:5000")
const LOCALHOST_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}/gi;
const groupSeenUrls = new Map<string, Set<string>>();

function scanAndEmitUrl(ws: WebSocket, groupKey: string, sessionId: string, chunk: string) {
  const matches = chunk.match(LOCALHOST_URL_RE);
  if (!matches) return;
  let set = groupSeenUrls.get(groupKey);
  if (!set) {
    set = new Set<string>();
    groupSeenUrls.set(groupKey, set);
  }
  for (const url of matches) {
    const normalized = url.replace(/\/+$/, "").toLowerCase();
    if (set.has(normalized)) continue;
    set.add(normalized);
    console.log(`[Harness] Detected URL: ${normalized} (session=${sessionId})`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`term:url:${sessionId}:${normalized}`);
    }
  }
}

interface Session {
  id: string;
  backend: Backend;
  ws: WebSocket;
  proc?: ReturnType<typeof spawn>;
  pty?: { write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: () => void; onData: (cb: (d: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void };
}

const sessions = new Map<string, Session[]>();
let nextId = 1;

const isWin = process.platform === "win32";

function getShellPath(): string {
  return isWin ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
}

function escapePwshSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function escapePwshDoubleQuoted(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"');
}

function getPathKey(env: NodeJS.ProcessEnv): string {
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === "path") return k;
  }
  return "PATH";
}

function buildEnvForCwd(cwd: string, venvDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = getPathKey(env);
  const delim = isWin ? ";" : ":";

  const extra: string[] = [];
  if (isWin) {
    const preferredScripts = venvDir ? path.join(cwd, venvDir, "Scripts") : "";
    const venvScripts = path.join(cwd, "venv", "Scripts");
    const dotVenvScripts = path.join(cwd, ".venv", "Scripts");
    const envScripts = path.join(cwd, "env", "Scripts");
    const dotEnvScripts = path.join(cwd, ".env", "Scripts");
    const nodeBin = path.join(cwd, "node_modules", ".bin");
    if (preferredScripts && fs.existsSync(preferredScripts)) extra.push(preferredScripts);
    if (fs.existsSync(venvScripts)) extra.push(venvScripts);
    if (fs.existsSync(dotVenvScripts)) extra.push(dotVenvScripts);
    if (fs.existsSync(envScripts)) extra.push(envScripts);
    if (fs.existsSync(dotEnvScripts)) extra.push(dotEnvScripts);
    if (fs.existsSync(nodeBin)) extra.push(nodeBin);
  } else {
    const preferredBin = venvDir ? path.join(cwd, venvDir, "bin") : "";
    const venvBin = path.join(cwd, "venv", "bin");
    const dotVenvBin = path.join(cwd, ".venv", "bin");
    const envBin = path.join(cwd, "env", "bin");
    const dotEnvBin = path.join(cwd, ".env", "bin");
    const nodeBin = path.join(cwd, "node_modules", ".bin");
    if (preferredBin && fs.existsSync(preferredBin)) extra.push(preferredBin);
    if (fs.existsSync(venvBin)) extra.push(venvBin);
    if (fs.existsSync(dotVenvBin)) extra.push(dotVenvBin);
    if (fs.existsSync(envBin)) extra.push(envBin);
    if (fs.existsSync(dotEnvBin)) extra.push(dotEnvBin);
    if (fs.existsSync(nodeBin)) extra.push(nodeBin);
  }

  const current = env[pathKey] || "";
  env[pathKey] = extra.length ? `${extra.join(delim)}${delim}${current}` : current;
  return env;
}

function getShellArgs(cwd: string, venvDir?: string, activateScript?: string): string[] {
  if (isWin) {
    const c = escapePwshSingleQuoted(cwd);
    const v = escapePwshSingleQuoted((venvDir || "").trim());
    const act = (activateScript || "").trim();
    const actQ = act ? escapePwshDoubleQuoted(act) : "";
    const init = [
      `Set-Location -LiteralPath '${c}'`,
      actQ ? `& "${actQ}"` : ``,
      v ? `if (Test-Path ('.\\${v}\\Scripts\\Activate.ps1')) { . ('.\\${v}\\Scripts\\Activate.ps1') }` : ``,
      `if (Test-Path '.\\venv\\Scripts\\Activate.ps1') { . '.\\venv\\Scripts\\Activate.ps1' } elseif (Test-Path '.\\.venv\\Scripts\\Activate.ps1') { . '.\\.venv\\Scripts\\Activate.ps1' } elseif (Test-Path '.\\env\\Scripts\\Activate.ps1') { . '.\\env\\Scripts\\Activate.ps1' } elseif (Test-Path '.\\.env\\Scripts\\Activate.ps1') { . '.\\.env\\Scripts\\Activate.ps1' }`,
      `if (Test-Path '.\\node_modules\\.bin') { $env:Path = (Resolve-Path '.\\node_modules\\.bin').Path + ';' + $env:Path }`,
    ].filter(Boolean).join("; ");
    return ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", init];
  }
  const init = [
    `cd "${cwd.replace(/"/g, '\\"')}"`,
    venvDir ? `if [ -f "./${venvDir.replace(/"/g, '\\"')}/bin/activate" ]; then . "./${venvDir.replace(/"/g, '\\"')}/bin/activate"; fi` : ``,
    `if [ -f "./venv/bin/activate" ]; then . "./venv/bin/activate"; elif [ -f "./.venv/bin/activate" ]; then . "./.venv/bin/activate"; elif [ -f "./env/bin/activate" ]; then . "./env/bin/activate"; elif [ -f "./.env/bin/activate" ]; then . "./.env/bin/activate"; fi`,
    `if [ -d "./node_modules/.bin" ]; then export PATH="$(pwd)/node_modules/.bin:$PATH"; fi`,
    `exec ${getShellPath()}`,
  ].filter(Boolean).join("; ");
  return ["-lc", init];
}

export function createSession(ws: WebSocket, groupKey: string, opts?: { cwd?: string; venvDir?: string; activateScript?: string }): string {
  const id = String(nextId++);
  const shell = getShellPath();
  let cwd = os.homedir();
  if (opts?.cwd) {
    try {
      if (fs.statSync(opts.cwd).isDirectory()) cwd = opts.cwd;
    } catch {}
  }

  const venvDir = opts?.venvDir;
  const args = getShellArgs(cwd, venvDir, opts?.activateScript);
  const env = buildEnvForCwd(cwd, venvDir);

  const group = sessions.get(groupKey) || [];

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(`term:out:${id}:[Harness] cwd=${cwd}${venvDir ? ` venvDir=${venvDir}` : ""}\r\n`);
  }

  if (process.env.HARNESS_DISABLE_PTY !== "1") {
    try {
      const nodePty: { spawn: (...a: any[]) => any } = require("node-pty");
      const pty = nodePty.spawn(shell, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd,
        env,
        ...(isWin ? { useConpty: true } : {}),
      });

      const session: Session = { id, backend: "pty", ws, pty };
      group.push(session);
      sessions.set(groupKey, group);

      pty.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`term:out:${id}:${data}`);
          scanAndEmitUrl(ws, groupKey, id, data);
        }
      });

      pty.onExit(({ exitCode }: { exitCode: number }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`term:exit:${id}:${exitCode ?? -1}`);
        }
        removeSession(groupKey, id);
      });

      ws.send(`term:ready:${id}:pty`);
      return id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`term:out:${id}:PTY unavailable, falling back to pipes: ${msg}\r\n`);
      }
    }
  }

  const proc = spawn(shell, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const session: Session = { id, backend: "pipe", proc, ws };

  proc.stdout?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`term:out:${id}:${data.toString()}`);
      scanAndEmitUrl(ws, groupKey, id, data.toString());
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`term:out:${id}:${data.toString()}`);
      scanAndEmitUrl(ws, groupKey, id, data.toString());
    }
  });

  proc.on("close", (code) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`term:exit:${id}:${code ?? -1}`);
    }
    removeSession(groupKey, id);
  });

  proc.on("error", (err) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`term:out:${id}:Shell error: ${err.message}\r\n`);
    }
  });

  group.push(session);
  sessions.set(groupKey, group);

  ws.send(`term:ready:${id}:pipe`);
  return id;
}

export function writeToSession(groupKey: string, sessionId: string, data: string) {
  const group = sessions.get(groupKey);
  const s = group?.find((x) => x.id === sessionId);
  if (!s) return;
  if (s.backend === "pty") {
    s.pty?.write(data);
    return;
  }
  if (s.proc?.stdin?.writable) s.proc.stdin.write(data);
}

export function resizeSession(groupKey: string, sessionId: string, cols: number, rows: number) {
  const group = sessions.get(groupKey);
  const s = group?.find((x) => x.id === sessionId);
  if (!s) return;
  if (s.backend === "pty") {
    try { s.pty?.resize(cols, rows); } catch {}
    return;
  }
}

export function killSession(groupKey: string, sessionId: string) {
  const group = sessions.get(groupKey);
  const s = group?.find((x) => x.id === sessionId);
  if (s) {
    if (s.backend === "pty") {
      try { s.pty?.kill(); } catch {}
    } else {
      s.proc?.kill();
    }
  }
  removeSession(groupKey, sessionId);
}

export function killAllInGroup(groupKey: string) {
  const group = sessions.get(groupKey);
  if (group) {
    for (const s of group) {
      if (s.backend === "pty") {
        try { s.pty?.kill(); } catch {}
      } else {
        s.proc?.kill();
      }
    }
    sessions.delete(groupKey);
    groupSeenUrls.delete(groupKey);
  }
}

function removeSession(groupKey: string, sessionId: string) {
  const group = sessions.get(groupKey);
  if (group) {
    const idx = group.findIndex((x) => x.id === sessionId);
    if (idx !== -1) group.splice(idx, 1);
    if (group.length === 0) sessions.delete(groupKey);
  }
}
