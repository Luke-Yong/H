import { spawn, spawnSync, ChildProcess } from "child_process";
import path from "path";

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

// language id → { bin: executable to detect on PATH, cmd/args: how to launch over stdio }.
// Covers the common VS Code language servers. Aliases share the same entry.
// Entries are only used if `bin` is actually installed (see commandExists) —
// otherwise diagnostics are skipped silently with no failing process spawn.
interface ServerSpec { bin: string; cmd: string; args: string[]; }

const SERVER_SPECS: Record<string, ServerSpec> = (() => {
  const s = (bin: string, args: string[] = [], cmd?: string): ServerSpec => ({ bin, cmd: cmd || bin, args });
  const tsServer = s("typescript-language-server", ["--stdio"]);
  const cssServer = s("vscode-css-language-server", ["--stdio"]);
  return {
    python: s("pylsp", ["--check-parent-process"]),
    typescript: tsServer, javascript: tsServer,
    typescriptreact: tsServer, javascriptreact: tsServer,
    go: s("gopls"),
    rust: s("rust-analyzer"),
    c: s("clangd"), cpp: s("clangd"), "objective-c": s("clangd"),
    java: s("jdtls"),
    swift: s("sourcekit-lsp"),
    ruby: s("solargraph", ["stdio"]),
    php: s("intelephense", ["--stdio"]),
    markdown: s("marksman", ["server"]),
    sql: s("sqls"),
    json: s("vscode-json-languageserver", ["--stdio"]), jsonc: s("vscode-json-languageserver", ["--stdio"]),
    html: s("vscode-html-language-server", ["--stdio"]),
    css: cssServer, scss: cssServer, less: cssServer,
    yaml: s("yaml-language-server", ["--stdio"]),
    shell: s("bash-language-server", ["start"]), shellscript: s("bash-language-server", ["start"]),
    lua: s("lua-language-server"),
    dockerfile: s("docker-langserver", ["--stdio"]),
    vue: s("vue-language-server", ["--stdio"]),
    svelte: s("svelteserver", ["--stdio"]),
    dart: s("dart", ["language-server"]),
    kotlin: s("kotlin-language-server"),
    csharp: s("omnisharp", ["-lsp"]),
    elixir: s("elixir-ls"),
    haskell: s("haskell-language-server-wrapper", ["--lsp"]),
    terraform: s("terraform-ls", ["serve"]),
    clojure: s("clojure-lsp"),
    ocaml: s("ocamllsp"),
    zig: s("zls"),
    scala: s("metals"),
    toml: s("taplo", ["lsp", "stdio"]),
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
  const spec = SERVER_SPECS[language];
  if (!spec) return null;
  // Graceful skip: don't spawn a server that isn't installed.
  if (!commandExists(spec.bin)) return null;
  return { cmd: spec.cmd, args: spec.args };
}

export function startLsp(rootPath: string, language: string): string | null {
  const key = makeKey(rootPath, language);
  if (sessions.has(key)) return key;

  const cmdInfo = getLspCmd(language, rootPath);
  if (!cmdInfo) return null;

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
    rootUri: `file:///${rootPath.replace(/\\/g, "/")}`,
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
          } catch { /* incomplete */ break; }
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
      } catch { /* malformed */ }
    }
  });

  proc.stderr!.on("data", (d) => { /* LSP stderr — ignore */ });
  proc.on("close", (code) => {
    sessions.delete(key);
    console.log(`LSP ${language} exited with code ${code}`);
  });
  proc.on("error", () => {
    sessions.delete(key);
  });

  sessions.set(key, session);

  // Send initialize
  sendRequest(session, "initialize", {
    processId: process.pid,
    rootUri: session.rootUri,
    capabilities: {
      textDocument: {
        completion: { completionItem: { snippetSupport: false } },
        publishDiagnostics: { relatedInformation: true },
        hover: { contentFormat: ["plaintext", "markdown"] },
      },
    },
  }).then(() => {
    sendNotification(session, "initialized", {});
    // Push per-language configuration to tame noisy linters (fewer false positives).
    const settings = INIT_SETTINGS[language];
    if (settings) {
      sendNotification(session, "workspace/didChangeConfiguration", { settings });
    }
    session.initialized = true;
  }).catch(() => { /* */ });

  return key;
}

// Per-language LSP settings to reduce false-positive noise.
const INIT_SETTINGS: Record<string, any> = {
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
    const uri: string = msg.params.uri;
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
    const uri = `file:///${filePath.replace(/\\/g, "/")}`;

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

// Send the latest file text to the language server and return its diagnostics.
// Used for continuous (debounced) error/warning checking while editing.
export async function getFileDiagnostics(
  rootPath: string, language: string, filePath: string, text: string
): Promise<MonacoMarker[]> {
  const key = startLsp(rootPath, language);
  if (!key) return [];
  const session = sessions.get(key);
  if (!session) return [];

  // Wait (best effort) for the server to finish initializing.
  for (let i = 0; i < 20 && !session.initialized; i++) await delay(100);
  if (!session.initialized) return [];

  const uri = `file:///${filePath.replace(/\\/g, "/")}`;
  // Clear the cache so we can detect a *fresh* publish for this exact text.
  diagnosticsByUri.delete(uri);
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

  // Poll for the server to publish diagnostics (cold starts can be slow).
  // Returns as soon as a publish lands (even an empty list = clean file).
  for (let i = 0; i < 15; i++) {
    await delay(200);
    if (diagnosticsByUri.has(uri)) return diagnosticsByUri.get(uri)!;
  }
  return diagnosticsByUri.get(uri) || [];
}
