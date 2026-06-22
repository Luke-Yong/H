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
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
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
