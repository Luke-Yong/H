export interface VFile {
  id: string;
  name: string;
  language: string;
  content: string;
  _fsPath?: string;
  _fsHandle?: FileSystemFileHandle;
  _encoding?: string;
}

export function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    html: "html",
    htm: "html",
    css: "css",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    jsonc: "jsonc",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    pyi: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    cs: "csharp",
    php: "php",
    phtml: "php",
    swift: "swift",
    kt: "kotlin",
    kts: "kotlin",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    sql: "sql",
    sh: "shell",
    bat: "bat",
    ps1: "powershell",
  };
  return map[ext || ""] || "plaintext";
}

let _id = 1;
export function createFile(name: string, content = ""): VFile {
  return { id: String(_id++), name, language: detectLanguage(name), content };
}

// ── File-type icons (Material Icon Theme SVGs, resolved to asset URLs by Vite) ──
const ICON_URLS = import.meta.glob(
  "../../node_modules/material-icon-theme/icons/*.svg",
  { eager: true, query: "?url", import: "default" }
) as Record<string, string>;

const ICON_BY_NAME: Record<string, string> = {};
for (const [k, v] of Object.entries(ICON_URLS)) {
  const m = k.match(/\/([^/]+)\.svg$/);
  if (m) ICON_BY_NAME[m[1]] = v;
}

// File extension → Material icon name
const EXT_ICON: Record<string, string> = {
  ts: "typescript", tsx: "react_ts", js: "javascript", jsx: "react",
  mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  java: "java", kt: "kotlin", kts: "kotlin", cs: "csharp",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  go: "go", rs: "rust", rb: "ruby", php: "php", phtml: "php",
  swift: "swift",
  html: "html", htm: "html", css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  md: "markdown", markdown: "markdown",
  sql: "database",
  xml: "xml",
  sh: "console", bash: "console", zsh: "console", bat: "console", ps1: "powershell",
  lua: "lua", vue: "vue", svelte: "svelte",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image",
  ico: "image", webp: "image", bmp: "image",
  mp4: "video", mov: "video", avi: "video", webm: "video", mkv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio",
};

// Exact filename (lowercased) → Material icon name
const NAME_ICON: Record<string, string> = {
  "package.json": "nodejs",
  "package-lock.json": "npm",
  "tsconfig.json": "tsconfig",
  ".gitignore": "git",
  ".gitattributes": "git",
  "dockerfile": "docker",
  "readme.md": "readme",
  "readme": "readme",
};

function urlFor(iconName: string): string {
  return ICON_BY_NAME[iconName] || ICON_BY_NAME["file"];
}

/** Resolve a file name to its Material Icon Theme SVG URL. */
export function fileIconUrl(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (NAME_ICON[lower]) return urlFor(NAME_ICON[lower]);
  if (lower.startsWith("tsconfig.") && lower.endsWith(".json")) return urlFor("tsconfig");
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return urlFor(EXT_ICON[ext] || "file");
}

/** Folder icon URL (open vs closed). */
export function folderIconUrl(expanded: boolean): string {
  return urlFor(expanded ? "folder-open" : "folder");
}
