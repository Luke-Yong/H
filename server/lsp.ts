import { spawn, spawnSync, ChildProcess } from "child_process";
import path from "path";
import { pathToFileURL } from "url";

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

// LSP severity (1=Error,2=Warning,3=Info,4=Hint) → Monaco severity
function mapSeverity(sev: number | undefined): number {
  switch (sev) {
    case 1: return 8;
    case 2: return 4;
    case 3: return 2;
    case 4: return 1;
    default: return 4;
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
// Different LSP servers encode drive letters differently (e.g. pyright uses
// d%3A while Node's pathToFileURL uses D:), so we decode and lowercase.
function normalizeUri(uri: string): string {
  try {
    return decodeURIComponent(uri).toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
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
    sessions.delete(key);
    sessionErrors.set(key, `LSP "${spec.cmd}" exited with code ${code}`);
    console.log(`LSP ${language} (${spec.cmd}) exited with code ${code}`);
  });
  proc.on("error", (err) => {
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
      sendNotification(session, "workspace/didChangeConfiguration", {
        settings: {
          python: {
            analysis: {
              typeCheckingMode: "basic",
              diagnosticMode: "openFilesOnly",
              autoSearchPaths: true,
              useLibraryCodeForTypes: true,
            },
          },
        },
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
    diagnosticsByUri.set(uri, diags.map((d) => ({
      message: d.message,
      severity: mapSeverity(d.severity),
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
      source: d.source,
      code: typeof d.code === "object" ? d.code?.value : (d.code != null ? String(d.code) : undefined),
    })));
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

let cachedDiagnostics: Record<string, Array<{ file: string; diagnostics: any[] }>> = {};
let completionResolvers: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }> = new Map();

export function getDiagnostics(language: string): Array<{ file: string; diagnostics: any[] }> {
  return cachedDiagnostics[language] || [];
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

// Send the latest file text to the language server and return its diagnostics.
// Used for continuous (debounced) error/warning checking while editing.
// Iterates through SERVER_SPECS in priority order; if the first server fails
// to initialise, it automatically falls back to the next one.
// Returns an `error` field when LSP is unavailable so the client can show feedback.
export async function getFileDiagnostics(
  rootPath: string, language: string, filePath: string, text: string
): Promise<FileDiagnosticsResult> {
  const specs = SERVER_SPECS[language];
  if (!specs) {
    return { markers: [], error: `No LSP server configured for language "${language}"` };
  }

  let anyInstalled = false;
  let lastError: string | undefined;

  for (const spec of specs) {
    const exists = commandExists(spec.bin);
    if (exists) anyInstalled = true;
    const failed = failedCommands.has(spec.cmd);
    if (!exists || failed) {
      if (!exists) lastError = `LSP binary "${spec.bin}" not found on PATH`;
      else lastError = `LSP "${spec.cmd}" previously failed to initialise`;
      languageErrors.set(language, lastError);
      continue;
    }

    const key = startLspWithSpec(rootPath, language, spec);
    if (!key) {
      lastError = `Failed to start LSP "${spec.cmd}"`;
      languageErrors.set(language, lastError);
      continue;
    }
    // Check for a previously recorded session error (crash, etc.)
    if (sessionErrors.has(key)) {
      lastError = sessionErrors.get(key);
    }
    const session = sessions.get(key);
    if (!session) {
      lastError = `LSP session for "${spec.cmd}" disappeared`;
      languageErrors.set(language, lastError!);
      continue;
    }

    // Wait (best effort) for the server to finish initializing.
    for (let i = 0; i < 50 && !session.initialized; i++) await delay(100);
    if (!session.initialized) {
      // Server never initialised — kill it, remember the failure, try next.
      const errMsg = `LSP "${spec.cmd}" init timeout`;
      console.error(errMsg);
      failedCommands.add(spec.cmd);
      sessionErrors.set(key, errMsg);
      languageErrors.set(language, errMsg);
      try { session.proc.kill(); } catch {}
      sessions.delete(key);
      lastError = errMsg;
      continue;
    }
    // Pyright needs a moment to process workspace/didChangeConfiguration
    // before it will publish diagnostics for didOpen.
    if (spec.cmd === "pyright-langserver") await delay(500);

    const uri = toFileUri(filePath, false);
    const normUri = normalizeUri(uri);
    diagnosticsByUri.delete(normUri);
    if (!session.openedUris.has(uri)) {
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

    // Wait for diagnostics.  Some servers (pylsp) send an empty batch first,
    // then the real analysis a moment later.  We poll for a non‑empty result
    // with a total cap of 5 s, but if we *have* seen at least one (empty) batch
    // we shorten the timeout to avoid blocking the UI when the file has no errors.
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
        if (cur.length > 0) break;               // real analysis ─ done
        if (!emptySeenAt) emptySeenAt = now;     // first empty batch timestamp
      }
      // If we received an empty batch, only wait POST_EMPTY_MS for real results.
      if (emptySeenAt && now - emptySeenAt >= POST_EMPTY_MS) break;
    }
    if (!markers) markers = diagnosticsByUri.get(normUri);
    // Clear the language-level error on a successful diagnostics fetch.
    languageErrors.delete(language);
    return { markers: markers || [] };
  }

  if (!anyInstalled) {
    const bins = specs.map(s => `"${s.bin}"`).join(", ");
    const err = `No LSP binary installed for "${language}". Install one of: ${bins}`;
    languageErrors.set(language, err);
    return { markers: [], error: err };
  }

  languageErrors.set(language, lastError || `All LSP servers for "${language}" failed`);
  return { markers: [], error: lastError || `All LSP servers for "${language}" failed` };
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
