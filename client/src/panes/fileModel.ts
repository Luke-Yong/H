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
