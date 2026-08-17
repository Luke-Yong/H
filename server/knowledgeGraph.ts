// ── Knowledge Graph Builder ──
// Builds a codebase knowledge graph from the filesystem:
//   Nodes: directories, files, and symbols (exports: functions, classes, etc.)
//   Edges: CONTAINS (structural), IMPORTS (file-level), EXPORTS (file→symbol),
//          IMPORTS_SYMBOL (precise symbol-level dependency)
//   Imports: per-file named-import records with stdlib/third-party/local
//            classification and unused-import detection.
//
// Output format (.kg):
//   # comment
//   n<id>|<type>|<parent_id>||<name>|<kind>
//   e<id>|<from_id>|<to_id>|<type>
//   i<from_id>|<module>|<classification>|<target_file_id>|<names>|<unused>
//
//   type: dir | file | symbol
//   kind: for files = extension (ts, py, ...), for symbols = function|class|const|type|interface|enum|default
//   classification: local | stdlib | third-party
//
// Designed for:
//   - Token-efficient storage (compact edge list derivative)
//   - Graph queries (PageRank, shortest path, adjacency)
//   - GNN input: node features (type, kind, name) + edge types
//   - Path prediction: Markov chain over IMPORTS_SYMBOL edges
//   - "What file exports function X?" — one-hop EXPORTS edge query
//   - "Which imports are unused?" — unused-import detection per file
//
// Ignored: .env, .gitignore, node_modules, venv, .venv, __pycache__, dist, .git

import fs from "fs";
import path from "path";
import ts from "typescript";

// ── Types ──

export type NodeType = "dir" | "file" | "symbol";
export type EdgeType = "CONTAINS" | "IMPORTS" | "EXPORTS" | "IMPORTS_SYMBOL";

export interface KGNode {
  id: string;
  type: NodeType;
  parentId: string; // empty for root, file id for symbols
  name: string;
  ext: string; // file: extension without dot; symbol: kind (function|class|const|type|interface|enum|default)
  absPath: string;
}

export interface KGEdge {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
}

/** How an import target was classified. */
export type ImportClassification = "local" | "stdlib" | "third-party";

/** A single imported name (the original name plus its local alias/binding). */
export interface ImportName {
  imported: string; // name as written after `import`/`from ... import`
  local: string;    // local binding (alias, or the same as imported)
}

/** A resolved named-import record attached to a file node. */
export interface NamedImport {
  fromId: string;               // importing file node id
  module: string;               // module path as written
  names: ImportName[];          // imported names (symbols, or the module itself)
  classification: ImportClassification;
  targetFileId: string | null;  // resolved local file id, if any
  targetNames: string[];        // local names that matched an exported symbol
  unused: string[];             // local names never referenced outside import lines
}

export interface KnowledgeGraph {
  rootAbsPath: string;
  nodes: Map<string, KGNode>;  // id -> node
  edges: KGEdge[];
  imports: NamedImport[];      // named imports (local + external) per file
}

// ── Constants ──

/** Directory names/patterns to exclude from the graph. */
const IGNORE_DIR_NAMES = new Set([
  // VCS
  ".git", ".svn", ".hg",
  // Dependencies
  "node_modules", "bower_components", "jspm_packages",
  // Python
  "__pycache__", ".venv", "venv", ".env", ".tox", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", ".eggs", "*.egg-info",
  // JS/TS build output
  "dist", "build", ".next", ".nuxt", ".output", ".turbo",
  ".parcel-cache", ".eslintcache", "out", ".tsbuildinfo",
  // IDE / editor
  ".idea", ".vscode", ".vs", ".fleet",
  // Test / coverage
  "coverage", ".nyc_output", "__snapshots__", ".jest-cache",
  // Java / Gradle / Maven
  ".gradle", "target", ".settings", "bin",
  // .NET
  "obj", "packages",
  // Rust
  "target",
  // PHP / Go
  "vendor",
  // Terraform / Infrastructure
  ".terraform",
  // Misc
  ".cache", "tmp", "temp", "logs", ".sass-cache",
]);

/** File name patterns to exclude. Exact names first, then patterns checked by suffix/prefix. */
const IGNORE_FILE_NAMES = new Set([
  // Secrets
  ".env", ".env.local", ".env.development", ".env.production",
  ".env.test", ".env.staging",
  // Git
  ".gitignore", ".gitattributes", ".gitmodules", ".gitkeep",
  // OS junk
  ".DS_Store", "Thumbs.db", "desktop.ini",
  // Logs
  "npm-debug.log", "yarn-error.log", "yarn-debug.log",
  // Ignore files (just lists of patterns — not code)
  ".eslintignore", ".prettierignore", ".npmignore", ".dockerignore",
  ".gitignore", ".hgignore",
]);

/**
 * Project config dotfiles that ARE included in the graph.
 * Everything else starting with "." is excluded unless listed here.
 */
const ALLOWED_DOTFILES = new Set([
  ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml",
  ".prettierrc", ".prettierrc.js", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.yml",
  ".editorconfig",
  ".babelrc", ".babelrc.js", ".babelrc.json",
  ".npmrc",
  ".nvmrc", ".node-version",
  ".browserslistrc",
  ".stylelintrc", ".stylelintrc.js", ".stylelintrc.json",
  ".commitlintrc.js", ".commitlintrc.json",
  ".huskyrc", ".lintstagedrc", ".lintstagedrc.js", ".lintstagedrc.json",
  ".releaserc", ".releaserc.js", ".releaserc.json",
  ".czrc", ".cz.json",
  ".swcrc",
]);

/** File name suffixes that indicate generated/minified/lock files. */
const IGNORE_FILE_SUFFIXES = [
  ".min.js", ".min.css", ".min.js.map", ".min.css.map",
  ".bundle.js", ".bundle.css",
  "-lock.json", "-lock.yaml", ".lock", ".lockb",
  ".d.ts.map",
  ".pyc", ".pyo",
  ".class", ".jar", ".war",
  ".o", ".obj", ".a", ".so", ".dylib", ".dll", ".pdb", ".exe",
  ".wasm",
  ".tgz", ".tar.gz", ".zip", ".rar", ".7z", ".gz", ".bz2",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".icns",
  ".webp", ".bmp", ".tiff", ".avif",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov", ".mkv",
  ".ttf", ".woff", ".woff2", ".eot", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".db", ".sqlite", ".sqlite3",
];

/** Extensions for which we parse imports (module/package dependencies). */
const IMPORTABLE_EXTS = new Set([
  // TypeScript / JavaScript
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  // Python
  ".py", ".pyx", ".pyi",
  // Rust
  ".rs",
  // Go
  ".go",
  // Java / Kotlin
  ".java", ".kt", ".kts",
  // C#
  ".cs",
  // Ruby
  ".rb",
  // PHP
  ".php",
  // Swift
  ".swift",
  // Scala
  ".scala",
  // Dart
  ".dart",
  // Vue / Svelte
  ".vue", ".svelte",
]);

/**
 * Project config dot-directories that ARE included in the graph.
 * Everything else starting with "." is excluded unless listed here.
 */
const ALLOWED_DOTDIRS = new Set([
  ".github",
  ".husky",
  ".storybook",
  ".changeset",
  ".vscode",       // workspace settings, launch configs, extensions
  ".devcontainer", // Docker dev environment
]);

// ── Filter Helpers ──

function isIgnoredDir(name: string): boolean {
  if (IGNORE_DIR_NAMES.has(name)) return true;
  // Dot-directories: only include if explicitly allowed (project configs)
  if (name.startsWith(".") && !ALLOWED_DOTDIRS.has(name)) return true;
  return false;
}

function isIgnoredFile(name: string): boolean {
  if (IGNORE_FILE_NAMES.has(name)) return true;
  // Dotfiles: only include if explicitly allowed (project configs)
  if (name.startsWith(".") && !ALLOWED_DOTFILES.has(name)) return true;
  // Check suffix patterns
  const lower = name.toLowerCase();
  for (const suffix of IGNORE_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

function shouldParseImports(ext: string): boolean {
  return IMPORTABLE_EXTS.has("." + ext);
}

// ── Import classification ──

/** Python standard-library top-level modules (first dotted segment). */
const PY_STDLIB_MODULES = new Set([
  "abc", "argparse", "ast", "asyncio", "base64", "bisect", "builtins",
  "calendar", "cmath", "collections", "concurrent", "configparser", "contextlib",
  "copy", "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib",
  "enum", "functools", "gc", "glob", "gzip", "hashlib", "heapq", "hmac",
  "html", "http", "importlib", "inspect", "io", "itertools", "json", "keyword",
  "linecache", "locale", "logging", "lzma", "marshal", "math", "mimetypes",
  "multiprocessing", "operator", "os", "pathlib", "pickle", "platform", "pprint",
  "profile", "pstats", "queue", "random", "re", "readline", "resource", "runpy",
  "secrets", "shlex", "shutil", "signal", "site", "socket", "sqlite3", "ssl",
  "stat", "statistics", "string", "struct", "subprocess", "sys", "sysconfig",
  "tempfile", "textwrap", "threading", "time", "timeit", "tkinter", "token",
  "tokenize", "traceback", "tracemalloc", "types", "typing", "unicodedata",
  "unittest", "urllib", "uuid", "venv", "warnings", "weakref", "xml", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);

/** Node.js built-in modules. */
const NODE_BUILTIN_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os",
  "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** Classify an import target as local, stdlib, or third-party. */
export function classifyImport(module: string, fromFile: string, resolved: boolean): ImportClassification {
  if (module.startsWith(".") || module.startsWith("/") || module.startsWith("@/")) return "local";

  const ext = path.extname(fromFile).toLowerCase();
  const top = module.split(/[./]/)[0];

  if (ext === ".py" || ext === ".pyi" || ext === ".pyx") {
    if (PY_STDLIB_MODULES.has(top)) return "stdlib";
  } else {
    if (module.startsWith("node:")) return "stdlib";
    if (NODE_BUILTIN_MODULES.has(top)) return "stdlib";
  }

  if (resolved) return "local";
  return "third-party";
}

// ── Builder ──

let nodeSeq = 0;
let edgeSeq = 0;
function nextNodeId(): string { return `n${nodeSeq++}`; }
function nextEdgeId(): string { return `e${edgeSeq++}`; }

/** Build a knowledge graph from the workspace root. */
export function buildKnowledgeGraph(workspacePath: string): KnowledgeGraph {
  nodeSeq = 0;
  edgeSeq = 0;

  const absRoot = path.resolve(workspacePath);
  const rootName = path.basename(absRoot) || absRoot;
  const nodes = new Map<string, KGNode>();
  const edges: KGEdge[] = [];

  // Root node
  const rootId = nextNodeId();
  nodes.set(rootId, {
    id: rootId, type: "dir", parentId: "", name: rootName, ext: "", absPath: absRoot,
  });

  // Recursively walk filesystem
  const fileNodes: KGNode[] = [];
  walkDir(absRoot, rootId, nodes, edges, fileNodes);

  // Parse exports first → symbol nodes + EXPORTS edges, indexed for import matching.
  const symbolIds = new Map<string, Map<string, string>>(); // fileId → (name → symbolId)
  for (const fileNode of fileNodes) {
    const result = parseExports(fileNode);
    for (const symNode of result.nodes) {
      nodes.set(symNode.id, symNode);
      let byName = symbolIds.get(fileNode.id);
      if (!byName) { byName = new Map(); symbolIds.set(fileNode.id, byName); }
      byName.set(symNode.name, symNode.id);
    }
    edges.push(...result.edges);
  }

  // Parse imports → IMPORTS (file-level), IMPORTS_SYMBOL (precise), and named-import records.
  const imports: NamedImport[] = [];
  for (const fileNode of fileNodes) {
    if (!shouldParseImports(fileNode.ext)) continue;
    let content: string;
    try { content = fs.readFileSync(fileNode.absPath, "utf-8"); } catch { continue; }

    const parsed = extractImports(content, "." + fileNode.ext);
    for (const imp of parsed) {
      const target = resolveImportTarget(imp.module, fileNode.absPath, nodes);
      const classification = classifyImport(imp.module, fileNode.absPath, target !== null);

      let targetFileId: string | null = null;
      const targetNames: string[] = [];

      if (target && target.type === "file") {
        targetFileId = target.id;
        edges.push({ id: nextEdgeId(), fromId: fileNode.id, toId: target.id, type: "IMPORTS" });
        const byName = symbolIds.get(target.id);
        if (byName) {
          for (const name of imp.names) {
            const symId = byName.get(name.imported);
            if (symId) {
              edges.push({ id: nextEdgeId(), fromId: fileNode.id, toId: symId, type: "IMPORTS_SYMBOL" });
              targetNames.push(name.local);
            }
          }
        }
      }

      const unused = imp.names
        .filter((name) => !isNameUsed(content, name.local))
        .map((name) => name.local);

      imports.push({
        fromId: fileNode.id,
        module: imp.module,
        names: imp.names,
        classification,
        targetFileId,
        targetNames,
        unused,
      });
    }
  }

  return { rootAbsPath: absRoot, nodes, edges, imports };
}

/** Lightweight tree fingerprint (file count + latest mtime) for cache invalidation. */
export function computeWorkspaceFingerprint(workspacePath: string): string {
  let count = 0;
  let latestMs = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && isIgnoredDir(entry.name)) continue;
      if (!entry.isDirectory() && isIgnoredFile(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        count++;
        try { latestMs = Math.max(latestMs, fs.statSync(abs).mtimeMs); } catch { /* ignore */ }
      }
    }
  };
  walk(path.resolve(workspacePath));
  return `${count}:${Math.floor(latestMs)}`;
}

function walkDir(
  dirPath: string,
  parentId: string,
  nodes: Map<string, KGNode>,
  edges: KGEdge[],
  fileNodes: KGNode[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort: dirs first, then files, both alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (entry.isDirectory() && isIgnoredDir(entry.name)) continue;
    if (!entry.isDirectory() && isIgnoredFile(entry.name)) continue;

    const absPath = path.join(dirPath, entry.name);
    const nodeId = nextNodeId();

    if (entry.isDirectory()) {
      nodes.set(nodeId, {
        id: nodeId, type: "dir", parentId, name: entry.name, ext: "", absPath,
      });
      edges.push({ id: nextEdgeId(), fromId: parentId, toId: nodeId, type: "CONTAINS" });
      walkDir(absPath, nodeId, nodes, edges, fileNodes);
    } else {
      const ext = path.extname(entry.name).replace(/^\./, "");
      nodes.set(nodeId, {
        id: nodeId, type: "file", parentId, name: entry.name, ext, absPath,
      });
      edges.push({ id: nextEdgeId(), fromId: parentId, toId: nodeId, type: "CONTAINS" });
      fileNodes.push(nodes.get(nodeId)!);
    }
  }
}

// ── Import Parser ──

interface ParsedImport {
  module: string;
  names: ImportName[];
}

/** Extract named imports (module + names) from source content. */
function extractImports(content: string, ext: string): ParsedImport[] {
  if (ext === ".py" || ext === ".pyi" || ext === ".pyx") {
    return extractPythonImports(content);
  }
  return extractJsImports(content);
}

function stripInlineComment(text: string): string {
  const idx = text.indexOf("#");
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

function parseImportNames(text: string): ImportName[] {
  const names: ImportName[] = [];
  for (const part of text.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const asMatch = p.match(/^([\w.]+)\s+as\s+(\w+)$/);
    if (asMatch) names.push({ imported: asMatch[1], local: asMatch[2] });
    else names.push({ imported: p, local: p });
  }
  return names;
}

/** Python: `import a, b as c` and `from X import a, b as c`. */
function extractPythonImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  for (const raw of content.split(/\r?\n/)) {
    // Only module-level (column 0) imports; skip indented imports inside functions/classes.
    if (!raw || /^[ \t]/.test(raw)) continue;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    let m = line.match(/^from\s+([\.\w]+)\s+import\s+(.+)$/);
    if (m) {
      const names = parseImportNames(stripInlineComment(m[2]));
      if (names.length > 0) results.push({ module: m[1], names });
      continue;
    }

    m = line.match(/^import\s+(.+)$/);
    if (m) {
      // `import os, json` → one record per top-level module.
      for (const name of parseImportNames(stripInlineComment(m[1]))) {
        results.push({ module: name.imported, names: [name] });
      }
    }
  }
  return results;
}

/** JS/TS: named, default, namespace, and bare/dynamic imports. */
function extractJsImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  let m: RegExpExecArray | null;

  // import { a, b as c } from 'mod'
  const namedRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(content)) !== null) {
    const names: ImportName[] = [];
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const asMatch = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (asMatch) names.push({ imported: asMatch[1], local: asMatch[2] });
      else names.push({ imported: p, local: p });
    }
    if (names.length > 0) results.push({ module: m[2].trim(), names });
  }

  // import Default from 'mod' (also `import Default, { x } from 'mod'`)
  const defaultRe = /import\s+([A-Za-z_$][\w$]*)\s*,?\s*(?:\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = defaultRe.exec(content)) !== null) {
    results.push({ module: m[2].trim(), names: [{ imported: "default", local: m[1] }] });
  }

  // import * as ns from 'mod'
  const nsRe = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = nsRe.exec(content)) !== null) {
    results.push({ module: m[2].trim(), names: [{ imported: "*", local: m[1] }] });
  }

  // require('mod') / import('mod') / side-effect import 'mod'
  const bareRe = /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"])/g;
  while ((m = bareRe.exec(content)) !== null) {
    const mod = m[1] || m[2] || m[3];
    if (mod) results.push({ module: mod.trim(), names: [] });
  }

  return results;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `name` appears as an identifier outside import/from statements. */
function isNameUsed(content: string, name: string): boolean {
  if (!name) return true;
  const identRe = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`);
  let inString = false;
  for (let raw of content.split(/\r?\n/)) {
    // Strip trailing inline comments (best-effort).
    const hashIdx = raw.indexOf("#");
    if (hashIdx >= 0) raw = raw.slice(0, hashIdx);
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Skip docstrings / multi-line strings (triple-quoted).
    const triples = (raw.match(/"""/g) || []).length + (raw.match(/'''/g) || []).length;
    if (inString) {
      if (triples % 2 === 1) inString = false;
      continue;
    }
    if (triples % 2 === 1) { inString = true; continue; }

    // The import statement itself is not a usage.
    if (/^(?:import\b|from\b|export\b)/.test(trimmed)) continue;
    if (identRe.test(raw)) return true;
  }
  return false;
}

/** Resolve an import path to a node in the graph. */
function resolveImportTarget(
  importPath: string,
  fromFile: string,
  nodes: Map<string, KGNode>,
): KGNode | null {
  const fromDir = path.dirname(fromFile);
  const candidates: string[] = [];
  const ext = path.extname(fromFile);
  const isPython = ext === ".py" || ext === ".pyi" || ext === ".pyx";

  if (importPath.startsWith(".")) {
    if (isPython) {
      // Python relative import: leading dots = package levels, remainder = module.
      let rest = importPath;
      let levels = 0;
      while (rest.startsWith(".")) { rest = rest.slice(1); levels++; }
      if (rest) {
        const up = "../".repeat(levels - 1);
        candidates.push(path.resolve(fromDir, up, rest));
      }
      // `from . import x` / `from .. import x` → package-level, no single file target.
    } else {
      candidates.push(path.resolve(fromDir, importPath));
    }
  } else if (importPath.startsWith("/")) {
    candidates.push(importPath);
  } else if (importPath.startsWith("@/")) {
    // Alias — skip for now (would need tsconfig paths)
    return null;
  } else {
    // Bare import or top-level module — might map to a local file
    // Try: same dir / importPath
    candidates.push(path.resolve(fromDir, importPath));
  }

  for (const cand of candidates) {
    // Direct match
    for (const node of nodes.values()) {
      if (node.absPath === cand) return node;
    }
    // Try adding the source extension
    for (const node of nodes.values()) {
      if (node.absPath === cand + ext) return node;
    }
    // Try common extensions
    for (const tryExt of [".ts", ".tsx", ".js", ".jsx", ".py", "/index.ts", "/index.js", "/index.tsx"]) {
      for (const node of nodes.values()) {
        if (node.absPath === cand + tryExt) return node;
      }
    }
  }

  return null;
}

// ── Export Parser ──

interface ExportResult {
  nodes: KGNode[];
  edges: KGEdge[];
}

/** Parse exported symbols from a supported source file into symbol nodes + EXPORTS edges. */
function parseExports(fileNode: KGNode): ExportResult {
  const ext = "." + fileNode.ext;
  if (TS_PARSEABLE_EXTS.has(ext)) return parseTsExports(fileNode);
  if (PY_PARSEABLE_EXTS.has(ext)) return parsePythonExports(fileNode);
  return { nodes: [], edges: [] };
}

/** Parse exports from a TS/JS file using the TypeScript compiler API. */
function parseTsExports(fileNode: KGNode): ExportResult {
  const ext = "." + fileNode.ext;

  let content: string;
  try { content = fs.readFileSync(fileNode.absPath, "utf-8"); } catch { return { nodes: [], edges: [] }; }

  const sourceFile = ts.createSourceFile(
    fileNode.absPath, content, ts.ScriptTarget.Latest, true,
    ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const result: ExportResult = { nodes: [], edges: [] };
  const isExported = (node: ts.Node): boolean => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (!modifiers) return false;
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword);
  };

  const visit = (node: ts.Node): void => {
    // export function / export default function
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      addSymbol(result, fileNode, node.name.text, isDefault ? "default" : "function");
    }
    // export class / export default class
    else if (ts.isClassDeclaration(node) && node.name && isExported(node)) {
      const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      addSymbol(result, fileNode, node.name.text, isDefault ? "default" : "class");
    }
    // export const / export let / export var
    else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          addSymbol(result, fileNode, decl.name.text, "const");
        }
      }
    }
    // export type / export interface
    else if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && isExported(node)) {
      addSymbol(result, fileNode, node.name.text, ts.isInterfaceDeclaration(node) ? "interface" : "type");
    }
    // export enum
    else if (ts.isEnumDeclaration(node) && node.name && isExported(node)) {
      addSymbol(result, fileNode, node.name.text, "enum");
    }
    // export { foo, bar } or export { foo as bar }
    else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        addSymbol(result, fileNode, element.name.text, "const");
      }
    }
    // export default <expr> (anonymous)
    else if (ts.isExportAssignment(node) && !node.isExportEquals) {
      addSymbol(result, fileNode, "default", "default");
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return result;
}

const TS_PARSEABLE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const PY_PARSEABLE_EXTS = new Set([".py", ".pyi", ".pyx"]);

/** Whether a file extension has an export parser. */
export function canParseExports(ext: string): boolean {
  return TS_PARSEABLE_EXTS.has("." + ext) || PY_PARSEABLE_EXTS.has("." + ext);
}

function addSymbol(result: ExportResult, fileNode: KGNode, name: string, kind: string): void {
  const id = nextNodeId();
  result.nodes.push({
    id, type: "symbol", parentId: fileNode.id, name, ext: kind, absPath: fileNode.absPath,
  });
  result.edges.push({
    id: nextEdgeId(), fromId: fileNode.id, toId: id, type: "EXPORTS",
  });
}

/** Parse Python exports: module-level `def`, `class`, and `name = value` bindings. */
function parsePythonExports(fileNode: KGNode): ExportResult {
  let content: string;
  try { content = fs.readFileSync(fileNode.absPath, "utf-8"); } catch { return { nodes: [], edges: [] }; }

  const result: ExportResult = { nodes: [], edges: [] };
  const seen = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    // Only module-level (column 0) definitions; skip indented blocks, comments, decorators.
    if (!line || /^[ \t]/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;

    let m: RegExpMatchArray | null;

    m = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (m) { addPySymbol(result, fileNode, seen, m[1], "function"); continue; }

    m = line.match(/^class\s+(\w+)\b/);
    if (m) { addPySymbol(result, fileNode, seen, m[1], "class"); continue; }

    // Annotated module-level binding: name: Type = value
    m = line.match(/^([A-Za-z_]\w*)\s*:\s*[^=\n]+=/);
    if (m) { addPySymbol(result, fileNode, seen, m[1], "const"); continue; }

    // Plain module-level binding: name = value
    m = line.match(/^([A-Za-z_]\w*)\s*=/);
    if (m) addPySymbol(result, fileNode, seen, m[1], "const");
  }

  return result;
}

function addPySymbol(result: ExportResult, fileNode: KGNode, seen: Set<string>, name: string, kind: string): void {
  if (name.startsWith("_")) return; // skip private/dunder names
  if (seen.has(name)) return;
  seen.add(name);
  addSymbol(result, fileNode, name, kind);
}

// ── Serialization ──

/** Serialize the knowledge graph to .kg format (compact edge list derivative). */
export function serializeGraph(graph: KnowledgeGraph): string {
  const lines: string[] = [];

  lines.push(`# Knowledge Graph v3 — ${graph.rootAbsPath}`);
  lines.push(`# Nodes: ${graph.nodes.size}  Edges: ${graph.edges.length}  Imports: ${graph.imports.length}`);
  lines.push(`# Format: n<id>|<type>|<parentId>||<name>|<kind>`);
  lines.push(`#         e<id>|<fromId>|<toId>|<type>`);
  lines.push(`#         i<fromId>|<module>|<classification>|<targetFileId>|<names>|<unused>`);
  lines.push(`#   type: dir|file|symbol  kind: ext for files, function|class|const|type|interface|enum|default for symbols`);
  lines.push(`#   classification: local|stdlib|third-party  names: imported:local pairs, unused: local names`);
  lines.push("");

  // Sort nodes for stable output
  const sortedNodes = [...graph.nodes.values()].sort((a, b) => {
    const numA = parseInt(a.id.slice(1), 10);
    const numB = parseInt(b.id.slice(1), 10);
    return numA - numB;
  });

  for (const node of sortedNodes) {
    lines.push(`n${node.id.slice(1)}|${node.type}|${node.parentId || ""}||${node.name}|${node.ext}`);
  }

  if (graph.edges.length > 0) {
    lines.push("");
    // Sort edges: structural first, then EXPORTS, then IMPORTS, then IMPORTS_SYMBOL
    const edgeOrder: Record<string, number> = { CONTAINS: 0, EXPORTS: 1, IMPORTS: 2, IMPORTS_SYMBOL: 3 };
    const sortedEdges = [...graph.edges].sort((a, b) => {
      const oa = edgeOrder[a.type] ?? 9;
      const ob = edgeOrder[b.type] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.id.localeCompare(b.id);
    });
    for (const edge of sortedEdges) {
      lines.push(`e${edge.id.slice(1)}|${edge.fromId}|${edge.toId}|${edge.type}`);
    }
  }

  if (graph.imports.length > 0) {
    lines.push("");
    for (const imp of graph.imports) {
      const names = imp.names.map((n) => (n.imported === n.local ? n.local : `${n.imported}:${n.local}`)).join(",");
      lines.push(`i${imp.fromId}|${imp.module}|${imp.classification}|${imp.targetFileId || ""}|${names}|${imp.unused.join(",")}`);
    }
  }

  return lines.join("\n") + "\n";
}

/** Visualize the graph as a nested tree (human-readable). */
export function visualizeGraph(graph: KnowledgeGraph): string {
  const root = [...graph.nodes.values()].find((n) => n.parentId === "" && n.type === "dir");
  if (!root) return "(empty)";

  const lines: string[] = [];
  lines.push(`${root.name} {`);

  // Collect IMPORTS_SYMBOL for annotation, fall back to IMPORTS
  const symImportsByFile: Map<string, string[]> = new Map();
  for (const edge of graph.edges) {
    if (edge.type === "IMPORTS_SYMBOL") {
      const target = graph.nodes.get(edge.toId);
      if (target) {
        const list = symImportsByFile.get(edge.fromId) || [];
        list.push(target.name);
        symImportsByFile.set(edge.fromId, list);
      }
    }
  }
  // Fall back: file-level imports for files without symbol-level matches
  for (const edge of graph.edges) {
    if (edge.type === "IMPORTS") {
      const existing = symImportsByFile.get(edge.fromId);
      if (!existing || existing.length === 0) {
        const target = graph.nodes.get(edge.toId);
        if (target) {
          const list = symImportsByFile.get(edge.fromId) || [];
          list.push(target.name + "/*");
          symImportsByFile.set(edge.fromId, list);
        }
      }
    }
  }

  // Collect exports per file
  const exportsByFile: Map<string, string[]> = new Map();
  for (const edge of graph.edges) {
    if (edge.type === "EXPORTS") {
      const sym = graph.nodes.get(edge.toId);
      if (sym) {
        const list = exportsByFile.get(edge.fromId) || [];
        list.push(`${sym.name}:${sym.ext}`);
        exportsByFile.set(edge.fromId, list);
      }
    }
  }

  renderDir(root.id, graph, symImportsByFile, exportsByFile, lines, 1);
  lines.push("}");

  // Summary
  const stats = { exports: 0, imports_file: 0, imports_sym: 0 };
  for (const e of graph.edges) {
    if (e.type === "EXPORTS") stats.exports++;
    else if (e.type === "IMPORTS") stats.imports_file++;
    else if (e.type === "IMPORTS_SYMBOL") stats.imports_sym++;
  }
  lines.push("");
  if (stats.exports > 0) lines.push(`# ${stats.exports} exports`);
  if (stats.imports_file > 0) lines.push(`# ${stats.imports_file} file-level imports`);
  if (stats.imports_sym > 0) lines.push(`# ${stats.imports_sym} symbol-level imports`);

  return lines.join("\n") + "\n";
}

function renderDir(
  dirId: string,
  graph: KnowledgeGraph,
  importsByFile: Map<string, string[]>,
  exportsByFile: Map<string, string[]>,
  lines: string[],
  depth: number,
): void {
  const children = graph.edges
    .filter((e) => e.type === "CONTAINS" && e.fromId === dirId)
    .map((e) => graph.nodes.get(e.toId)!)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const indent = "  ".repeat(depth);

  for (const child of children) {
    if (child.type === "dir") {
      lines.push(`${indent}${child.name} {`);
      renderDir(child.id, graph, importsByFile, exportsByFile, lines, depth + 1);
      lines.push(`${indent}}`);
    } else if (child.type === "file") {
      const imps = importsByFile.get(child.id);
      const exps = exportsByFile.get(child.id);
      const parts: string[] = [];
      if (exps && exps.length > 0) parts.push(`exports: ${exps.join(", ")}`);
      if (imps && imps.length > 0) parts.push(`→ ${imps.join(", ")}`);
      lines.push(`${indent}${child.name}${parts.length ? "  (" + parts.join("; ") + ")" : ""}`);
    }
    // symbol nodes are not rendered inline — they appear in the file's export annotation
  }
}
