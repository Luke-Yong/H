import { spawn } from "child_process";
import { WebSocket } from "ws";
import fs from "fs";
import path from "path";

type Backend = "pty" | "pipe";

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

function getPathKey(env: NodeJS.ProcessEnv): string {
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === "path") return k;
  }
  return "PATH";
}

function buildEnvForCwd(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = getPathKey(env);
  const delim = isWin ? ";" : ":";

  const extra: string[] = [];
  if (isWin) {
    const venvScripts = path.join(cwd, "venv", "Scripts");
    const dotVenvScripts = path.join(cwd, ".venv", "Scripts");
    const nodeBin = path.join(cwd, "node_modules", ".bin");
    if (fs.existsSync(venvScripts)) extra.push(venvScripts);
    if (fs.existsSync(dotVenvScripts)) extra.push(dotVenvScripts);
    if (fs.existsSync(nodeBin)) extra.push(nodeBin);
  } else {
    const venvBin = path.join(cwd, "venv", "bin");
    const dotVenvBin = path.join(cwd, ".venv", "bin");
    const nodeBin = path.join(cwd, "node_modules", ".bin");
    if (fs.existsSync(venvBin)) extra.push(venvBin);
    if (fs.existsSync(dotVenvBin)) extra.push(dotVenvBin);
    if (fs.existsSync(nodeBin)) extra.push(nodeBin);
  }

  const current = env[pathKey] || "";
  env[pathKey] = extra.length ? `${extra.join(delim)}${delim}${current}` : current;
  return env;
}

function getShellArgs(cwd: string): string[] {
  if (isWin) {
    const c = escapePwshSingleQuoted(cwd);
    const init = [
      `Set-Location -LiteralPath '${c}'`,
      `if (Test-Path '.\\venv\\Scripts\\Activate.ps1') { . '.\\venv\\Scripts\\Activate.ps1' } elseif (Test-Path '.\\.venv\\Scripts\\Activate.ps1') { . '.\\.venv\\Scripts\\Activate.ps1' }`,
      `if (Test-Path '.\\node_modules\\.bin') { $env:Path = (Resolve-Path '.\\node_modules\\.bin').Path + ';' + $env:Path }`,
    ].join("; ");
    return ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", init];
  }
  const init = [
    `cd "${cwd.replace(/"/g, '\\"')}"`,
    `if [ -f "./venv/bin/activate" ]; then . "./venv/bin/activate"; elif [ -f "./.venv/bin/activate" ]; then . "./.venv/bin/activate"; fi`,
    `if [ -d "./node_modules/.bin" ]; then export PATH="$(pwd)/node_modules/.bin:$PATH"; fi`,
    `exec ${getShellPath()}`,
  ].join("; ");
  return ["-lc", init];
}

export function createSession(ws: WebSocket, groupKey: string, opts?: { cwd?: string }): string {
  const id = String(nextId++);
  const shell = getShellPath();
  let cwd = process.cwd();
  if (opts?.cwd) {
    try {
      if (fs.statSync(opts.cwd).isDirectory()) cwd = opts.cwd;
    } catch {}
  }

  const args = getShellArgs(cwd);
  const env = buildEnvForCwd(cwd);

  const group = sessions.get(groupKey) || [];

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
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`term:out:${id}:${data.toString()}`);
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
