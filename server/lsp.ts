import { spawn, spawnSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type { Response } from "express";

interface LspRequest {
  id: number;
  method: string;
  params: any;
}

interface LspResponse {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
  params?: any;
}

interface LspSession {
  proc: ChildProcess;
  buffer: string;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  nextId: number;
  language: string;
  rootUri: string;
  initialized: boolean;
  queue: Array<() => void>;
  openedUris: Set<string>;
  docVersions: Map<string, number>;
  sseClients: Set<Response>;
}

const sessions = new Map<string, LspSession>();

// Commands that failed to start / initialise — never retried (per process lifetime).
const failedCommands = new Set<string>();

// sessionKey → last error message for diagnostics & status reporting.
const sessionErrors = new Map<string, string>();

// language → last error message (for languages that never got a session).
const languageErrors = new Map<string, string>();

// uri → latest published diagnostics (already in Monaco shape)
const diagnosticsByUri = new Map<string, MonacoMarker[]>();

interface MonacoMarker {
  message: string;
  severity: number; // 1=Hint, 2=Info, 4=Warning, 8=Error
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  code?: string;
}

// LSP severity (1=Error,2=Warning,3=Info,4=Hint) → Monaco severity.
// Per LSP spec: "If omitted, diagnostics should be treated as errors."
function mapSeverity(sev: number | undefined): number {
  switch (sev) {
    case 1: return 8;
    case 2: return 4;
    case 3: return 2;
    case 4: return 1;
    default: return 8; // undefined → Error per LSP spec
  }
}

function makeKey(rootPath: string, language: string): string {
  return `${rootPath.replace(/\\/g, "/")}::${language}`;
}

function toFileUri(p: string, isDir: boolean): string {
  const abs = path.resolve(p);
  const finalPath = isDir ? (abs.endsWith(path.sep) ? abs : abs + path.sep) : abs;
  return pathToFileURL(finalPath).toString();
}

// Normalize a file:// URI for consistent map key lookups.
// Different LSP servers encode drive letters, spaces, and path separators
// differently (pyright may use d%3A or D%3A, with %5C backslashes or %2F
// forward slashes; pylsp may use bare characters).  We decode, lower-case,
// and convert all path separators to "/" so map lookups are reliable.
function normalizeUri(uri: string): string {
  // Progressive decoding: some servers double-encode or mix encoded/raw chars.
  let decoded = "";
  try {
    decoded = decodeURIComponent(uri);
    // Keep decoding if the result itself looks percent-encoded.
    for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(decoded); i++) {
      try { decoded = decodeURIComponent(decoded); } catch { break; }
    }
  } catch {
    // Fall back: replace %XX patterns we can decode, leave the rest.
    decoded = uri.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
      try { return decodeURIComponent("%" + hex); } catch { return "%" + hex; }
    });
  }
  return decoded.toLowerCase().replace(/\\/g, "/");
}

// language id → ordered list of LSP servers to try (first installed one wins).
// Each server is only used if its `bin` is found on PATH (see commandExists).
// Order matters: put servers with tolerant parsers (multi-error) first.
interface ServerSpec { bin: string; cmd: string; args: string[]; }

const SERVER_SPECS: Record<string, ServerSpec[]> = (() => {
  const s = (bin: string, args: string[] = [], cmd?: string): ServerSpec => ({ bin, cmd: cmd || bin, args });
  const tsServer: ServerSpec[] = [s("typescript-language-server", ["--stdio"])];
  const cssServer: ServerSpec[] = [s("vscode-css-language-server", ["--stdio"])];
  return {
    // pyright has a fault-tolerant parser → reports ALL errors (not just the first).
    // Fall back to pylsp if pyright isn't installed.
    python: [
      s("pyright-langserver", ["--stdio"]),
      s("pylsp", ["--check-parent-process"]),
    ],
    typescript: tsServer, javascript: tsServer,
    typescriptreact: tsServer, javascriptreact: tsServer,
    go: [s("gopls")],
    rust: [s("rust-analyzer")],
    c: [s("clangd")], cpp: [s("clangd")], "objective-c": [s("clangd")],
    java: [s("jdtls")],
    swift: [s("sourcekit-lsp")],
    ruby: [s("solargraph", ["stdio"])],
    php: [s("intelephense", ["--stdio"])],
    markdown: [s("marksman", ["server"])],
    sql: [s("sqls")],
    json: [s("vscode-json-languageserver", ["--stdio"])], jsonc: [s("vscode-json-languageserver", ["--stdio"])],
    html: [s("vscode-html-language-server", ["--stdio"])],
    css: cssServer, scss: cssServer, less: cssServer,
    yaml: [s("yaml-language-server", ["--stdio"])],
    shell: [s("bash-language-server", ["start"])], shellscript: [s("bash-language-server", ["start"])],
    lua: [s("lua-language-server")],
    dockerfile: [s("docker-langserver", ["--stdio"])],
    vue: [s("vue-language-server", ["--stdio"])],
    svelte: [s("svelteserver", ["--stdio"])],
    dart: [s("dart", ["language-server"])],
    kotlin: [s("kotlin-language-server")],
    csharp: [s("omnisharp", ["-lsp"])],
    elixir: [s("elixir-ls")],
    haskell: [s("haskell-language-server-wrapper", ["--lsp"])],
    terraform: [s("terraform-ls", ["serve"])],
    clojure: [s("clojure-lsp")],
    ocaml: [s("ocamllsp")],
    zig: [s("zls")],
    scala: [s("metals")],
    toml: [s("taplo", ["lsp", "stdio"])],
  };
})();

// Cache of which executables are present on this machine.
const commandAvailability = new Map<string, boolean>();
function commandExists(bin: string): boolean {
  if (commandAvailability.has(bin)) return commandAvailability.get(bin)!;
  let ok = false;
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(finder, [bin], { encoding: "utf8", shell: process.platform === "win32", timeout: 4000 });
    ok = r.status === 0 && !!(r.stdout || "").trim();
  } catch { ok = false; }
  commandAvailability.set(bin, ok);
  return ok;
}

// Detect a Python virtual environment directory under the project root.
// Checks common venv names (.venv, venv, env, .env) and returns the first
// match so pyright can resolve installed packages for that project.
function detectVenv(rootPath: string): string | null {
  const candidates = [".venv", "venv", "env", ".env"];
  for (const name of candidates) {
    const full = path.join(rootPath, name);
    // Must be a directory containing a pyvenv.cfg, or a Scripts/bin dir.
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (fs.existsSync(path.join(full, "pyvenv.cfg"))) return full;
      if (process.platform === "win32" && fs.existsSync(path.join(full, "Scripts", "python.exe"))) return full;
      if (fs.existsSync(path.join(full, "bin", "python")) || fs.existsSync(path.join(full, "bin", "python3"))) return full;
    } catch { continue; }
  }
  return null;
}

function getLspCmd(language: string, _rootPath: string): { cmd: string; args: string[] } | null {
  const specs = SERVER_SPECS[language];
  if (!specs) return null;
  // Return the first server whose binary is found on PATH.
  for (const spec of specs) {
    if (commandExists(spec.bin)) return { cmd: spec.cmd, args: spec.args };
  }
  return null;
}

export function startLsp(rootPath: string, language: string): string | null {
  const cmdInfo = getLspCmd(language, rootPath);
  if (!cmdInfo) return null;
  return startLspWithSpec(rootPath, language, { bin: cmdInfo.cmd, cmd: cmdInfo.cmd, args: cmdInfo.args });
}

function startLspWithSpec(rootPath: string, language: string, spec: ServerSpec): string | null {
  const cmdInfo = spec;
  const key = makeKey(rootPath, language) + "|" + cmdInfo.cmd;
  if (sessions.has(key)) return key;

  const proc = spawn(cmdInfo.cmd, cmdInfo.args, {
    cwd: rootPath,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    shell: process.platform === "win32",
  });

  const session: LspSession = {
    proc,
    buffer: "",
    pending: new Map(),
    nextId: 1,
    language,
    rootUri: toFileUri(rootPath, true),
    initialized: false,
    queue: [],
    openedUris: new Set(),
    docVersions: new Map(),
    sseClients: new Set(),
  };

  proc.stdout!.on("data", (chunk: Buffer) => {
    session.buffer += chunk.toString();
    // Parse complete JSON-RPC messages
    while (true) {
      const headerMatch = session.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) {
        // Try bare JSON (some servers don't use Content-Length header)
        const lines = session.buffer.split("\n");
        let depth = 0, start = -1, end = -1;
        for (let i = 0; i < lines.length; i++) {
          for (let j = 0; j < lines[i].length; j++) {
            if (lines[i][j] === "{") { if (depth === 0) start = i; depth++; }
            if (lines[i][j] === "}") { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end !== -1) break;
        }
        if (end !== -1 && start !== -1) {
          const msgStr = lines.slice(start, end + 1).join("\n");
          try {
            const msg = JSON.parse(msgStr) as LspResponse;
            session.buffer = lines.slice(end + 1).join("\n");
            handleMessage(session, msg);
            continue;
          } catch (e) {
            console.error(`[LSP:${session.language}:${spec.cmd}] bare JSON parse error: ${(e as Error).message}`);
            break;
          }
        }
        break;
      }
      const headerEnd = session.buffer.indexOf("\r\n\r\n") + 4;
      const contentLen = parseInt(headerMatch[1], 10);
      const totalNeeded = headerEnd + contentLen;
      if (session.buffer.length < totalNeeded) break;
      const body = session.buffer.slice(headerEnd, totalNeeded);
      session.buffer = session.buffer.slice(totalNeeded);
      try {
        const msg = JSON.parse(body) as LspResponse;
        handleMessage(session, msg);
      } catch (e) {
        console.error(`[LSP:${session.language}:${spec.cmd}] Content-Length message parse error: ${(e as Error).message}`);
      }
    }
  });

  proc.stderr!.on("data", (d) => {
    console.error(`[LSP:${language}:${cmdInfo.cmd}] ${String(d)}`);
  });
  proc.on("close", (code) => {
    // Clean up diagnostics for URIs opened by this session.
    for (const uri of session.openedUris) {
      diagnosticsByUri.delete(normalizeUri(uri));
    }
    sessions.delete(key);
    sessionErrors.set(key, `LSP "${spec.cmd}" exited with code ${code}`);
    console.log(`LSP ${language} (${spec.cmd}) exited with code ${code}`);
  });
  proc.on("error", (err) => {
    for (const uri of session.openedUris) {
      diagnosticsByUri.delete(normalizeUri(uri));
    }
    sessions.delete(key);
    sessionErrors.set(key, `LSP "${spec.cmd}" spawn error: ${err.message}`);
    console.error(`LSP ${language} (${spec.cmd}) spawn error: ${err.message}`);
  });

  sessions.set(key, session);

  // Send initialize
  sendRequest(session, "initialize", {
    processId: process.pid,
    rootUri: session.rootUri,
    workspaceFolders: [{ uri: session.rootUri, name: path.basename(rootPath) }],
    capabilities: {
      textDocument: {
        completion: { completionItem: { snippetSupport: false } },
        publishDiagnostics: { relatedInformation: true },
        hover: { contentFormat: ["plaintext", "markdown"] },
      },
      workspace: {
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: true },
      },
    },
  }).then(() => {
    sendNotification(session, "initialized", {});
    // Send per-language settings to the language server.
    if (cmdInfo.cmd === "pylsp") {
      const settings = INIT_SETTINGS_PYLSP[language];
      if (settings) {
        sendNotification(session, "workspace/didChangeConfiguration", { settings });
      }
    } else if (cmdInfo.cmd === "pyright-langserver") {
      const venvDir = detectVenv(rootPath);
      sendNotification(session, "workspace/didChangeConfiguration", {
        settings: {
          python: {
            analysis: {
              typeCheckingMode: "basic",
              diagnosticMode: "openFilesOnly",
              autoSearchPaths: true,
              useLibraryCodeForTypes: true,
              ...(venvDir ? { venvPath: path.dirname(venvDir), venv: path.basename(venvDir) } : {}),
              diagnosticSeverityOverrides: {
                // Import resolution — pyright often can't find installed packages
                // in venvs, monorepos, editable installs, namespace packages, etc.
                reportMissingImports: "warning",
                reportMissingTypeStubs: "none",
                // Optional-related rules — Python codebases commonly use Optional
                // without explicit guards; these are rarely real bugs at runtime.
                reportOptionalMemberAccess: "none",
                reportOptionalSubscript: "none",
                reportOptionalCall: "none",
                reportOptionalIterable: "none",
                reportOptionalContextManager: "none",
                reportOptionalOperand: "none",
                // Dynamic attribute access is idiomatic Python (ORM models,
                // __getattr__, mock objects, etc.).
                reportAttributeAccessIssue: "warning",
                // Type argument/assignment mismatches — downgrade to warning
                // since many are false positives on dynamic code.
                reportArgumentType: "warning",
                reportAssignmentType: "warning",
              },
            },
          },
        },
      });
    } else if (cmdInfo.cmd === "yaml-language-server") {
      // Disable schema-store lookups — unmatched schemas produce noisy
      // "Schema not found" / "Using schema from cache" false positives.
      sendNotification(session, "workspace/didChangeConfiguration", {
        settings: {
          yaml: { schemaStore: { enable: false }, validate: true },
        },
      });
    } else if (cmdInfo.cmd === "gopls") {
      // Disable staticcheck — it reports style/opinion suggestions that
      // read as false positives in a coding-agent workflow.
      sendNotification(session, "workspace/didChangeConfiguration", {
        settings: { gopls: { staticcheck: false } },
      });
    }
    session.initialized = true;
  }).catch((err) => {
    console.error(`LSP ${language} (${cmdInfo.cmd}) init failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  return key;
}

// Per-language LSP settings to reduce false-positive noise.
const INIT_SETTINGS_PYLSP: Record<string, any> = {
  python: {
    pylsp: {
      plugins: {
        // Keep real-bug detection (undefined names, unused imports, syntax).
        pyflakes: { enabled: true },
        jedi_completion: { enabled: true },
        // Disable noisy PEP8 / style / complexity nags that read as false positives.
        pycodestyle: { enabled: false },
        pydocstyle: { enabled: false },
        mccabe: { enabled: false },
        flake8: { enabled: false },
        pylint: { enabled: false },
      },
    },
  },
};

function handleMessage(session: LspSession, msg: LspResponse) {
  if (msg.id !== undefined && session.pending.has(msg.id)) {
    const cb = session.pending.get(msg.id)!;
    session.pending.delete(msg.id);
    if (msg.error) cb.reject(msg.error);
    else cb.resolve(msg.result);
    return;
  }
  // Capture diagnostics pushed by the server
  if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
    const uri = normalizeUri(msg.params.uri as string);
    const diags: any[] = msg.params.diagnostics || [];
    const MAX_DIAGS_PER_FILE = 200;
    const markers: MonacoMarker[] = [];
    for (const d of diags) {
      // Drop Info (3) and Hint (4) — they produce noise, not actionable feedback.
      const lspSeverity = d.severity;
      if (lspSeverity === 3 || lspSeverity === 4) continue;
      const startLine = d.range?.start?.line ?? 0;
      const startChar = d.range?.start?.character ?? 0;
      const endLine = d.range?.end?.line ?? startLine;
      const endChar = d.range?.end?.character ?? startChar;
      // Drop diagnostics with negative line/column or start > end (malformed).
      if (startLine < 0 || startChar < 0 || endLine < startLine) continue;
      if (endLine === startLine && endChar < startChar) continue;
      // Cap per-file diagnostics to avoid flooding the UI.
      if (markers.length >= MAX_DIAGS_PER_FILE) break;
      markers.push({
        message: d.message,
        severity: mapSeverity(lspSeverity),
        startLineNumber: startLine + 1,
        startColumn: startChar + 1,
        endLineNumber: endLine + 1,
        endColumn: endChar + 1,
        source: d.source,
        code: typeof d.code === "object" ? d.code?.value : (d.code != null ? String(d.code) : undefined),
      });
    }
    diagnosticsByUri.set(uri, markers);
    // Broadcast to all SSE clients watching this session
    const eventData = JSON.stringify({ uri, markers });
    for (const client of session.sseClients) {
      try { client.write(`data: ${eventData}\n\n`); } catch { session.sseClients.delete(client); }
    }
  }
}

function sendRequest(session: LspSession, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = session.nextId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const content = `Content-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`;
    session.proc.stdin!.write(content);
    session.pending.set(id, { resolve, reject });
  });
}

function sendNotification(session: LspSession, method: string, params: any) {
  const notif = JSON.stringify({ jsonrpc: "2.0", method, params });
  const content = `Content-Length: ${Buffer.byteLength(notif)}\r\n\r\n${notif}`;
  session.proc.stdin!.write(content);
}

export async function getCompletions(
  rootPath: string, language: string, filePath: string,
  line: number, column: number
): Promise<any[]> {
  const key = startLsp(rootPath, language);
  if (!key) return [];
  const session = sessions.get(key);
  if (!session || !session.initialized) return [];

  try {
    const uri = toFileUri(filePath, false);

    // Open document first
    await sendRequest(session, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: language,
        version: 1,
        text: "",
      },
    }).catch(() => { /* */ });

    const result = await sendRequest(session, "textDocument/completion", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    });

    if (!result) return [];
    if (Array.isArray(result)) return result.map(mapCompletionItem);
    if (result.items) return result.items.map(mapCompletionItem);
    return [];
  } catch {
    return [];
  }
}

function mapCompletionItem(item: any): any {
  return {
    label: item.label,
    kind: item.kind,
    detail: item.detail,
    documentation: item.documentation,
    insertText: item.insertText || item.label,
    sortText: item.sortText,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FileDiagnosticsResult {
  markers: MonacoMarker[];
  error?: string;
}

// Legacy polling — kept for backward compatibility.  Calls notifyFileChange
// to send didOpen/didChange and then polls diagnosticsByUri for the result.
// New code should use GET /api/lsp/watch (SSE) + notifyFileChange instead.
export async function getFileDiagnostics(
  rootPath: string, language: string, filePath: string, text: string
): Promise<FileDiagnosticsResult> {
  const result = await notifyFileChange(rootPath, language, filePath, text);
  if (!result.ok) return { markers: [], error: result.error };

  // Poll for diagnostics (fallback for clients not using SSE yet)
  const normUri = normalizeUri(toFileUri(filePath, false));
  const TOTAL_MS = 5000;
  const POST_EMPTY_MS = 1500;
  const tick = 200;
  let markers: MonacoMarker[] | undefined;
  let emptySeenAt = 0;
  for (let elapsed = 0; elapsed < TOTAL_MS; elapsed += tick) {
    await delay(tick);
    const cur = diagnosticsByUri.get(normUri);
    const now = Date.now();
    if (cur !== undefined) {
      markers = cur;
      if (cur.length > 0) break;
      if (!emptySeenAt) emptySeenAt = now;
    }
    if (emptySeenAt && now - emptySeenAt >= POST_EMPTY_MS) break;
  }
  if (!markers) markers = diagnosticsByUri.get(normUri);
  languageErrors.delete(language);
  return { markers: markers || [] };
}

// Return current LSP error state for status reporting.
export function getLspStatus(): Record<string, { language: string; error?: string }> {
  const result: Record<string, { language: string; error?: string }> = {};
  // Active session errors
  for (const [key, error] of sessionErrors) {
    const parts = key.split("|");
    result[key] = { language: parts[0] || "", error };
  }
  // Language-level errors (no binary, no spec, etc.)
  for (const [lang, error] of languageErrors) {
    if (!Object.values(result).some(r => r.language === lang && r.error === error)) {
      result[`lang:${lang}`] = { language: lang, error };
    }
  }
  return result;
}

// ── SSE-based real-time diagnostics (VS Code style) ──

// Start watching LSP diagnostics via SSE. Returns the session key.
// The caller (Express route) holds the connection open and stream
// publishDiagnostics events as they arrive from the LSP server.
export function watchDiagnostics(
  rootPath: string, language: string, res: Response
): { ok: true; sessionKey: string } | { ok: false; error: string } {
  const specs = SERVER_SPECS[language];
  if (!specs) return { ok: false, error: `No LSP server configured for language "${language}"` };

  for (const spec of specs) {
    if (!commandExists(spec.bin)) continue;
    if (failedCommands.has(spec.cmd)) continue;

    const key = startLspWithSpec(rootPath, language, spec);
    if (!key) continue;
    const session = sessions.get(key);
    if (!session) continue;

    // Wait for initialization (non-blocking — the SSE headers are already sent).
    (async () => {
      for (let i = 0; i < 50 && !session.initialized; i++) await delay(100);
      if (!session.initialized) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: "LSP init timeout" })}\n\n`); } catch {}
        res.end();
        return;
      }
      // Pyright needs a moment for workspace config
      if (spec.cmd === "pyright-langserver") await delay(500);
      // Flush diagnostics already published during init, scoped to this root.
      const normRoot = normalizeUri(session.rootUri);
      for (const [uri, markers] of diagnosticsByUri) {
        if (!uri.startsWith(normRoot)) continue;
        try { res.write(`data: ${JSON.stringify({ uri, markers })}\n\n`); } catch { return; }
      }
    })();

    session.sseClients.add(res);
    res.on("close", () => { session.sseClients.delete(res); });
    return { ok: true, sessionKey: key };
  }

  return { ok: false, error: "No LSP available for this language" };
}

// Notify the LSP server about a file change (didOpen/didChange).
// Fire-and-forget — the server will push diagnostics via SSE.
export async function notifyFileChange(
  rootPath: string, language: string, filePath: string, text: string
): Promise<{ ok: boolean; error?: string }> {
  const specs = SERVER_SPECS[language];
  if (!specs) return { ok: false, error: `No LSP for "${language}"` };

  for (const spec of specs) {
    if (!commandExists(spec.bin)) continue;
    if (failedCommands.has(spec.cmd)) continue;

    const key = startLspWithSpec(rootPath, language, spec);
    if (!key) continue;
    const session = sessions.get(key);
    if (!session) continue;

    for (let i = 0; i < 50 && !session.initialized; i++) await delay(100);
    if (!session.initialized) {
      return { ok: false, error: `LSP "${spec.cmd}" init timeout` };
    }
    if (spec.cmd === "pyright-langserver") await delay(500);

    const uri = toFileUri(filePath, false);
    const isNew = !session.openedUris.has(uri);
    if (isNew) {
      session.openedUris.add(uri);
      session.docVersions.set(uri, 1);
      sendNotification(session, "textDocument/didOpen", {
        textDocument: { uri, languageId: language, version: 1, text },
      });
    } else {
      const v = (session.docVersions.get(uri) || 1) + 1;
      session.docVersions.set(uri, v);
      sendNotification(session, "textDocument/didChange", {
        textDocument: { uri, version: v },
        contentChanges: [{ text }],
      });
    }
    return { ok: true };
  }
  return { ok: false, error: "No LSP available" };
}
