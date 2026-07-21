// ── Knowledge Graph Builder ──
// Builds a codebase knowledge graph from the filesystem:
//   Nodes: directories, files, and symbols (exports: functions, classes, etc.)
//   Edges: CONTAINS (structural), IMPORTS (file-level), EXPORTS (file→symbol),
//          IMPORTS_SYMBOL (precise symbol-level dependency)
//
// Output format (.kg):
//   # comment
//   n<id>|<type>|<parent_id>||<name>|<kind>
//   e<id>|<from_id>|<to_id>|<type>
//
//   type: dir | file | symbol
//   kind: for files = extension (ts, py, ...), for symbols = function|class|const|type|interface|enum|default
//
// Designed for:
//   - Token-efficient storage (compact edge list derivative)
//   - Graph queries (PageRank, shortest path, adjacency)
//   - GNN input: node features (type, kind, name) + edge types
//   - Path prediction: Markov chain over IMPORTS_SYMBOL edges
//   - "What file exports function X?" — one-hop EXPORTS edge query
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

export interface KnowledgeGraph {
  rootAbsPath: string;
  nodes: Map<string, KGNode>;  // id -> node
  edges: KGEdge[];
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

  // Parse imports for all source files
  for (const fileNode of fileNodes) {
    const importEdges = parseImports(fileNode, nodes);
    edges.push(...importEdges);
  }

  // Parse exports for TS/JS files → create symbol nodes + EXPORTS edges
  const exportMap = new Map<string, { node: KGNode; names: Set<string> }>(); // fileId → info
  for (const fileNode of fileNodes) {
    const result = parseExports(fileNode, nodes);
    for (const symNode of result.nodes) {
      nodes.set(symNode.id, symNode);
      let entry = exportMap.get(fileNode.id);
      if (!entry) { entry = { node: fileNode, names: new Set() }; exportMap.set(fileNode.id, entry); }
      entry.names.add(symNode.name);
    }
    edges.push(...result.edges);
  }

  // Match imports to specific exported symbols → IMPORTS_SYMBOL edges
  for (const fileNode of fileNodes) {
    if (!shouldParseImports(fileNode.ext)) continue;
    let content: string;
    try { content = fs.readFileSync(fileNode.absPath, "utf-8"); } catch { continue; }
    const namedImports = extractNamedImports(content, "." + fileNode.ext);
    for (const { importPath, names } of namedImports) {
      const target = resolveImportTarget(importPath, fileNode.absPath, nodes);
      if (!target) continue;
      const targetExports = exportMap.get(target.id);
      if (!targetExports) continue;
      for (const name of names) {
        if (targetExports.names.has(name)) {
          // Find the symbol node
          for (const edge of edges) {
            if (edge.type === "EXPORTS" && edge.fromId === target.id) {
              const sym = nodes.get(edge.toId);
              if (sym && sym.name === name) {
                edges.push({
                  id: nextEdgeId(),
                  fromId: fileNode.id,
                  toId: sym.id,
                  type: "IMPORTS_SYMBOL",
                });
              }
            }
          }
        }
      }
    }
  }

  return { rootAbsPath: absRoot, nodes, edges };
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

function parseImports(fileNode: KGNode, nodes: Map<string, KGNode>): KGEdge[] {
  if (!shouldParseImports(fileNode.ext)) return [];

  let content: string;
  try {
    content = fs.readFileSync(fileNode.absPath, "utf-8");
  } catch {
    return [];
  }

  const edges: KGEdge[] = [];
  const imports = extractImports(content, "." + fileNode.ext);

  for (const imp of imports) {
    const target = resolveImportTarget(imp, fileNode.absPath, nodes);
    if (target) {
      edges.push({
        id: nextEdgeId(),
        fromId: fileNode.id,
        toId: target.id,
        type: "IMPORTS",
      });
    }
  }

  return edges;
}

/** Extract import paths from source content. */
function extractImports(content: string, ext: string): string[] {
  const results: string[] = [];

  if (ext === ".py") {
    // Python: import foo, from foo import bar, from .foo import bar
    const pyRe = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
    let m: RegExpExecArray | null;
    while ((m = pyRe.exec(content)) !== null) {
      const pkg = (m[1] || m[2]).trim();
      if (pkg && !pkg.startsWith(".")) results.push(pkg);
    }
  } else {
    // JS/TS: import ... from '...', require('...'), import('...')
    const jsRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = jsRe.exec(content)) !== null) {
      const imp = m[1].trim();
      // Only resolve relative imports or project-local paths
      if (imp.startsWith(".") || imp.startsWith("/") || !imp.includes("/")) {
        results.push(imp);
      } else if (imp.startsWith("@/")) {
        results.push(imp);
      }
    }
  }

  return results;
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

  if (importPath.startsWith(".")) {
    // Relative import
    const resolved = path.resolve(fromDir, importPath);
    candidates.push(resolved);
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

// ── Export Parser (TypeScript/JavaScript AST) ──

interface ExportResult {
  nodes: KGNode[];
  edges: KGEdge[];
}

/** Parse exports from a TS/JS file using the TypeScript compiler API. */
function parseExports(fileNode: KGNode, _nodes: Map<string, KGNode>): ExportResult {
  const ext = "." + fileNode.ext;
  if (!TS_PARSEABLE_EXTS.has(ext)) return { nodes: [], edges: [] };

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

function addSymbol(result: ExportResult, fileNode: KGNode, name: string, kind: string): void {
  const id = nextNodeId();
  result.nodes.push({
    id, type: "symbol", parentId: fileNode.id, name, ext: kind, absPath: fileNode.absPath,
  });
  result.edges.push({
    id: nextEdgeId(), fromId: fileNode.id, toId: id, type: "EXPORTS",
  });
}

/** Extract named imports with their imported names and source path. */
function extractNamedImports(content: string, _ext: string): Array<{ importPath: string; names: string[] }> {
  const results: Array<{ importPath: string; names: string[] }> = [];

  // import { foo, bar } from './module'
  const namedRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(content)) !== null) {
    const names = m[1].split(",").map((s) => {
      // Handle "foo as bar" → extract "foo"
      const asIdx = s.indexOf(" as ");
      return (asIdx >= 0 ? s.slice(0, asIdx) : s).trim();
    }).filter(Boolean);
    results.push({ importPath: m[2].trim(), names });
  }

  return results;
}

// ── Serialization ──

/** Serialize the knowledge graph to .kg format (compact edge list derivative). */
export function serializeGraph(graph: KnowledgeGraph): string {
  const lines: string[] = [];

  lines.push(`# Knowledge Graph v2 — ${graph.rootAbsPath}`);
  lines.push(`# Nodes: ${graph.nodes.size}  Edges: ${graph.edges.length}`);
  lines.push(`# Format: n<id>|<type>|<parentId>||<name>|<kind>`);
  lines.push(`#         e<id>|<fromId>|<toId>|<type>`);
  lines.push(`#   type: dir|file|symbol  kind: ext for files, function|class|const|type|interface|enum|default for symbols`);
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
