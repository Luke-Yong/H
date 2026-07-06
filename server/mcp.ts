// ── Harness MCP Server ──
// Implements the Model Context Protocol (MCP) to expose Harness tools
// to MCP-compatible clients (Claude Desktop, Cursor, etc.).
//
// Supports both stdio transport (for standalone operation) and SSE transport
// (integrated into the existing Express server).
//
// Protocol: JSON-RPC 2.0 over stdio or HTTP SSE
// Spec: https://modelcontextprotocol.io

import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import { Readable, Writable } from "stream";
import { EventEmitter } from "events";

// ── Types ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type McpMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// MCP Tool definition
interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required: string[];
  };
}

// ── MCP Server Implementation ──

interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
}

interface ServerInfo {
  name: string;
  version: string;
}

export class HarnessMcpServer extends EventEmitter {
  private initialized = false;
  private clientCapabilities: Record<string, unknown> = {};
  private projectRoot: string;
  public readonly serverInfo: ServerInfo = {
    name: "harness",
    version: "1.0.0",
  };

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot || process.cwd();
  }

  setProjectRoot(root: string) {
    this.projectRoot = root;
  }

  // ── Tool Definitions ──

  getTools(): McpTool[] {
    return [
      {
        name: "read_file",
        description: "Read a file or list a directory's contents. Returns the file text with line numbers, or a directory listing.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file relative to the project root." },
            offset: { type: "integer", description: "Line number to start reading from (1-based)." },
            limit: { type: "integer", description: "Max lines to return." },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Create a new file or completely rewrite an existing file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to project root." },
            content: { type: "string", description: "Full file content to write." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Make a targeted edit to a file by replacing one string with another.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to project root." },
            old_string: { type: "string", description: "Exact text to find and replace." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace all occurrences (default false)." },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
      {
        name: "list_files",
        description: "List files and directories at a given project path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path relative to project root." },
          },
          required: ["path"],
        },
      },
      {
        name: "search_files",
        description: "Recursively search the project for files or folders matching a name pattern.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Substring to match in file/directory names (case-insensitive)." },
            subdir: { type: "string", description: "Optional subdirectory to search within." },
          },
          required: ["pattern"],
        },
      },
      {
        name: "grep",
        description: "Search file contents for a regex pattern across the project.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex or literal string to search for (case-insensitive)." },
            subdir: { type: "string", description: "Optional subdirectory to search within." },
            glob: { type: "string", description: "Optional file pattern to filter (e.g. '*.ts')." },
          },
          required: ["pattern"],
        },
      },
      {
        name: "run_command",
        description: "Run a short shell command and return stdout + stderr. Use for tests, lint, git, npm install, building, compiling.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run." },
          },
          required: ["command"],
        },
      },
      {
        name: "create_directory",
        description: "Create a new directory (and any parent directories as needed).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path relative to project root." },
          },
          required: ["path"],
        },
      },
      {
        name: "delete_file",
        description: "Delete a file or directory (recursively). Use with caution.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file or directory relative to project root." },
          },
          required: ["path"],
        },
      },
      {
        name: "rename_file",
        description: "Rename or move a file or directory.",
        inputSchema: {
          type: "object",
          properties: {
            oldPath: { type: "string", description: "Current path." },
            newPath: { type: "string", description: "New path (and name)." },
          },
          required: ["oldPath", "newPath"],
        },
      },
      {
        name: "git_status",
        description: "Get git status — staged and unstaged changes, current branch.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the git repository (defaults to project root)." },
          },
          required: [],
        },
      },
      {
        name: "git_log",
        description: "Get recent git commit history.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the git repository (defaults to project root)." },
            limit: { type: "integer", description: "Number of commits (default: 20)." },
          },
          required: [],
        },
      },
      {
        name: "git_diff",
        description: "Get the git diff for a specific file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the git repository (defaults to project root)." },
            file: { type: "string", description: "File to diff (relative to git root)." },
          },
          required: ["file"],
        },
      },
      {
        name: "system_info",
        description: "Get system information — CPU, memory, disk, OS details.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ];
  }

  // ── Tool Execution ──

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const resolve = (p: string) => path.resolve(this.projectRoot, p);

    // Secret-file guard
    const SECRET_PATTERNS = [
      /\.env$/i, /\.env\..*$/i, /credentials/i, /secret/i,
      /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
      /config\/.*secret/i, /config\/.*key/i,
    ];

    const isSecretPath = (p: string): boolean => {
      const name = path.basename(p);
      const relative = path.relative(this.projectRoot, p);
      return SECRET_PATTERNS.some((re) => re.test(name) || re.test(relative));
    };

    switch (name) {
      // ── Filesystem Tools ──
      case "read_file": {
        const filePath = resolve(String(args.path || ""));
        if (isSecretPath(filePath)) return `Blocked: ${args.path} may contain secrets.`;
        if (!fs.existsSync(filePath)) return `File not found: ${args.path}`;
        if (fs.statSync(filePath).isDirectory()) {
          const entries = fs.readdirSync(filePath, { withFileTypes: true });
          const listing = entries
            .filter((e) => e.name !== "node_modules" && e.name !== ".git")
            .map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
            .join("\n");
          return `Directory listing for ${args.path}:\n${listing || "(empty)"}`;
        }
        const text = fs.readFileSync(filePath, "utf-8");
        const lines = text.split("\n");
        const start = Math.max(1, Number(args.offset) || 1) - 1;
        const end = args.limit != null ? start + Number(args.limit) : lines.length;
        const slice = lines.slice(start, Math.min(end, lines.length));
        const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(4, " ")}| ${l}`).join("\n");
        return numbered || "(empty)";
      }

      case "write_file": {
        const filePath = resolve(String(args.path || ""));
        if (isSecretPath(filePath)) return `Blocked: ${args.path} may contain secrets.`;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const content = String(args.content || "");
        fs.writeFileSync(filePath, content, "utf-8");
        return `Wrote ${Math.round(content.length / 4)} tokens to ${args.path}.`;
      }

      case "edit_file": {
        const filePath = resolve(String(args.path || ""));
        if (isSecretPath(filePath)) return `Blocked: ${args.path} may contain secrets.`;
        if (!fs.existsSync(filePath)) return `File not found: ${args.path}`;
        const oldStr = String(args.old_string || "");
        const newStr = String(args.new_string || "");
        const replaceAll = Boolean(args.replace_all);
        if (!oldStr) return "old_string is required.";
        const original = fs.readFileSync(filePath, "utf-8");
        const count = (original.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        if (count === 0) return `old_string not found in ${args.path}.`;
        if (count > 1 && !replaceAll) {
          return `old_string matches ${count} locations in ${args.path}. Use replace_all: true to replace all.`;
        }
        const result = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
        fs.writeFileSync(filePath, result, "utf-8");
        return replaceAll
          ? `Replaced ${count} occurrences in ${args.path}.`
          : `Replaced in ${args.path}.`;
      }

      case "list_files": {
        const dirPath = resolve(String(args.path || "."));
        if (!fs.existsSync(dirPath)) return `Directory not found: ${args.path}`;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
          .join("\n");
      }

      case "search_files": {
        const base = resolve(String(args.subdir || "."));
        if (!fs.existsSync(base)) return `Directory not found: ${args.subdir || "."}`;
        const pattern = String(args.pattern || "").toLowerCase();
        if (!pattern) return "Provide a non-empty pattern.";
        const results: string[] = [];
        const MAX = 80;
        function walk(dir: string) {
          if (results.length >= MAX) return;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name === "node_modules" || e.name === ".git") continue;
            const full = path.join(dir, e.name);
            if (e.name.toLowerCase().includes(pattern)) {
              results.push(path.relative(base, full).replace(/\\/g, "/") + (e.isDirectory() ? "/" : ""));
              if (results.length >= MAX) return;
            }
            if (e.isDirectory()) walk(full);
          }
        }
        walk(base);
        if (results.length === 0) return `No files or folders matching "${args.pattern}" found.`;
        return results.join("\n") + (results.length >= MAX ? `\n... (truncated at ${MAX} results)` : "");
      }

      case "grep": {
        const base = resolve(String(args.subdir || "."));
        if (!fs.existsSync(base)) return `Directory not found: ${args.subdir || "."}`;
        const rawPattern = String(args.pattern || "");
        if (!rawPattern) return "Provide a non-empty pattern.";
        let regex: RegExp;
        try { regex = new RegExp(rawPattern, "gi"); } catch { regex = new RegExp(rawPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); }
        const globStr = String(args.glob || "");
        const results: string[] = [];
        const MAX = 80;
        function walk(dir: string) {
          if (results.length >= MAX) return;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name === "node_modules" || e.name === ".git") continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (isSecretPath(full)) continue;
            if (globStr) {
              const ext = path.extname(e.name).toLowerCase();
              const g = globStr.toLowerCase();
              if (g.startsWith("*.")) { if (ext !== g.slice(1)) continue; }
              else if (!e.name.toLowerCase().includes(g)) continue;
            }
            try {
              const text = fs.readFileSync(full, "utf-8");
              const lines = text.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  regex.lastIndex = 0;
                  const rel = path.relative(base, full).replace(/\\/g, "/");
                  results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
                  if (results.length >= MAX) return;
                }
              }
            } catch { /* binary */ }
          }
        }
        walk(base);
        if (results.length === 0) return `No matches for "${rawPattern}" found.`;
        return results.join("\n") + (results.length >= MAX ? `\n... (truncated at ${MAX} results)` : "");
      }

      case "run_command": {
        const command = String(args.command || "");
        // Block cd/pushd
        if (/^(?:cd|pushd|chdir)\b/i.test(command.trimStart())) {
          return `Blocked: do NOT use cd/pushd. Working directory is already the project root.`;
        }
        return await this.executeCommand(command);
      }

      case "create_directory": {
        const dirPath = resolve(String(args.path || ""));
        fs.mkdirSync(dirPath, { recursive: true });
        return `Created directory: ${args.path}`;
      }

      case "delete_file": {
        const targetPath = resolve(String(args.path || ""));
        if (isSecretPath(targetPath)) return `Blocked: ${args.path} may contain secrets.`;
        if (!fs.existsSync(targetPath)) return `Not found: ${args.path}`;
        if (fs.statSync(targetPath).isDirectory()) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(targetPath);
        }
        return `Deleted: ${args.path}`;
      }

      case "rename_file": {
        const from = resolve(String(args.oldPath || ""));
        const to = resolve(String(args.newPath || ""));
        if (isSecretPath(from) || isSecretPath(to)) return `Blocked: path may contain secrets.`;
        if (!fs.existsSync(from)) return `Not found: ${args.oldPath}`;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return `Renamed ${args.oldPath} to ${args.newPath}.`;
      }

      // ── Git Tools ──
      case "git_status": {
        const cwd = args.path ? resolve(String(args.path)) : this.projectRoot;
        const gitRoot = this.findGitRoot(cwd);
        if (!gitRoot) return "Not a git repository.";
        const statusRaw = execSync("git status --porcelain -u", { cwd: gitRoot, encoding: "utf8", timeout: 5000 });
        const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: gitRoot, encoding: "utf8", timeout: 3000 }).trim();
        const lines = statusRaw.trim().split(/\r?\n/).filter(Boolean);
        const staged: string[] = [];
        const unstaged: string[] = [];
        for (const line of lines) {
          const idx = line.substring(0, 2);
          const file = line.substring(3).trim();
          if (idx[0] !== " ") staged.push(`${idx[0]} ${file}`);
          if (idx[1] !== " ") unstaged.push(`${idx[1]} ${file}`);
          if (idx === "  ") unstaged.push(`? ${file}`);
        }
        return `Branch: ${branch}\n\nStaged:\n${staged.join("\n") || "(none)"}\n\nUnstaged:\n${unstaged.join("\n") || "(none)"}`;
      }

      case "git_log": {
        const cwd = args.path ? resolve(String(args.path)) : this.projectRoot;
        const gitRoot = this.findGitRoot(cwd);
        if (!gitRoot) return "Not a git repository.";
        const limit = Number(args.limit) || 20;
        const raw = execSync(
          `git log --max-count=${limit} --format="%h %ad %an: %s" --date=short`,
          { cwd: gitRoot, encoding: "utf8", timeout: 5000 }
        );
        return raw.trim() || "(no commits)";
      }

      case "git_diff": {
        const cwd = args.path ? resolve(String(args.path)) : this.projectRoot;
        const gitRoot = this.findGitRoot(cwd);
        if (!gitRoot) return "Not a git repository.";
        const file = String(args.file || "");
        if (!file) return "file parameter is required.";
        const raw = execSync(`git diff -- "${file}"`, { cwd: gitRoot, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
        return raw || "(no changes)";
      }

      // ── System Tools ──
      case "system_info": {
        const os = await import("os");
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const uptime = os.uptime();
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);

        return [
          `Platform: ${os.platform()} ${os.arch()}`,
          `Hostname: ${os.hostname()}`,
          `CPU: ${cpus[0]?.model || "Unknown"} (${cpus.length} cores @ ${cpus[0]?.speed || "?"} MHz)`,
          `Memory: ${(usedMem / 1024 / 1024 / 1024).toFixed(1)} GB used / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB total (${Math.round((usedMem / totalMem) * 100)}%)`,
          `Uptime: ${hours}h ${mins}m`,
          `Project root: ${this.projectRoot}`,
          `CWD: ${process.cwd()}`,
        ].join("\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  // ── Helpers ──

  private findGitRoot(startDir: string): string | null {
    let dir = startDir;
    while (true) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private executeCommand(command: string): Promise<string> {
    return new Promise((resolve) => {
      const MAX_KEEP = 4000;
      let buf = "";
      let totalChars = 0;
      let timedOut = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const proc = spawn(command, [], {
        cwd: this.projectRoot,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const finish = (code: number | null) => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const out = buf.trimEnd();
        let prefix = "";
        if (totalChars > MAX_KEEP) {
          prefix = `... (showing last ${MAX_KEEP} of ${totalChars} chars)\n`;
        }
        if (timedOut) {
          prefix += `[Command timed out after 45s]\n`;
        }
        const result = prefix + (out || "(command completed with no output)");
        resolve(code !== 0 && code !== null && !timedOut ? `Exit code ${code}: ${result}` : result);
      };

      const hardTimer = setTimeout(() => {
        timedOut = true;
        proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
      }, 45000);

      idleTimer = setTimeout(() => {
        proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
      }, 2000);

      const collect = (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        totalChars += text.length;
        buf = (buf + text).slice(-MAX_KEEP);
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
        }, 2000);
      };

      proc.stdout?.on("data", collect);
      proc.stderr?.on("data", collect);

      proc.on("close", (code) => {
        clearTimeout(hardTimer);
        finish(code);
      });

      proc.on("error", (err) => {
        clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        resolve(`Failed to spawn: ${err.message}`);
      });
    });
  }

  // ── JSON-RPC Message Handling ──

  async handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = msg;

    // Notifications (no id) — no response needed
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        // Client confirmed initialization
        return null;
      }
      return null;
    }

    try {
      switch (method) {
        case "initialize": {
          const clientInfo = (params as any)?.clientInfo || {};
          this.clientCapabilities = (params as any)?.capabilities || {};
          this.initialized = true;

          const capabilities: ServerCapabilities = {
            tools: {},
          };

          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities,
              serverInfo: this.serverInfo,
            },
          };
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: this.getTools(),
            },
          };
        }

        case "tools/call": {
          const toolName = String((params as any)?.name || "");
          const toolArgs = ((params as any)?.arguments || {}) as Record<string, unknown>;

          const result = await this.callTool(toolName, toolArgs);

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: result }],
              isError: result.startsWith("Blocked:") || result.startsWith("Error:") || result.startsWith("Unknown tool:"),
            },
          };
        }

        case "resources/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resources: [],
            },
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

// ── Stdio Transport ──

export function runStdioServer(server: HarnessMcpServer) {
  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;

    // Parse complete JSON-RPC messages (newline-delimited)
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcRequest;
        const response = await server.handleMessage(msg);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch {
        // Send parse error
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32700, message: "Parse error" },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });

  // Prevent the process from exiting on EPIPE (client disconnects)
  process.stdout.on("error", () => {
    process.exit(0);
  });
}

// ── SSE Transport Helpers ──
// For integrating MCP into the existing Express server.

export function handleMcpSseRequest(
  server: HarnessMcpServer,
  reqBody: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  return server.handleMessage(reqBody);
}
