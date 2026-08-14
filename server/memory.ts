// ── Persistent Memory Store ──
// File-based, Trae-style memory layout. No native database dependency.
//
// Layout under ~/.h/memory/:
//   user_profile.md                          — cross-project user facts
//   projects/<slug>/project_memory.md        — project conventions/decisions
//   projects/<slug>/<YYYYMMDD>/topics.md     — topic-level goals/progress
//   projects/<slug>/<YYYYMMDD>/session_memory_<sessionId>.jsonl — message-level log
//
// Recall is keyword-based (grep-style) over the markdown/jsonl files; no
// embeddings and no native dependencies.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { MEMORY_DIR, USER_PROFILE_FILE, PROJECTS_DIR } from "./hPaths";

// ── Types ──

export interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  tags: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;
}

type MemoryScope = "user" | "project";

// ── Path helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "session";
}

/** Stable, filesystem-safe slug for a project root path. */
function projectSlug(projectRoot: string): string {
  const abs = path.resolve(projectRoot);
  const base = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = crypto.createHash("md5").update(abs).digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

function projectDir(projectRoot: string): string {
  return path.join(PROJECTS_DIR, projectSlug(projectRoot));
}

function projectMemoryFile(projectRoot: string): string {
  return path.join(projectDir(projectRoot), "project_memory.md");
}

function dateDir(projectRoot: string, d: Date = new Date()): string {
  return path.join(projectDir(projectRoot), formatDate(d));
}

function sessionFile(projectRoot: string, sessionId: string, d: Date = new Date()): string {
  return path.join(dateDir(projectRoot, d), `session_memory_${sanitizeSessionId(sessionId)}.jsonl`);
}

function topicsFile(projectRoot: string, d: Date = new Date()): string {
  return path.join(dateDir(projectRoot, d), "topics.md");
}

function fileMtimeIso(file: string): string {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    return "";
  }
}

// ── Markdown (de)serialisation for user_profile.md / project_memory.md ──

const HEADERS: Record<MemoryScope, string> = {
  user: "# User Profile",
  project: "# Project Memory",
};

function parseMemoryFile(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = content.split(/\r?\n/);

  let current: {
    key: string;
    category: string;
    tags: string;
    createdAt: string;
    updatedAt: string;
    valueLines: string[];
  } | null = null;
  let inValue = false;

  const flush = () => {
    if (!current) return;
    entries.push({
      key: current.key,
      value: current.valueLines.join("\n").trim(),
      category: current.category || "general",
      tags: current.tags,
      createdAt: current.createdAt || current.updatedAt || new Date().toISOString(),
      updatedAt: current.updatedAt,
    });
    current = null;
    inValue = false;
  };

  const matchPrefix = (line: string, prefix: string): string | null => {
    return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      current = {
        key: line.slice(3).trim(),
        category: "general",
        tags: "",
        createdAt: "",
        updatedAt: "",
        valueLines: [],
      };
      inValue = false;
      continue;
    }

    if (!current) continue;

    if (!inValue) {
      const category = matchPrefix(line, "- category:");
      if (category !== null) {
        current.category = category;
        continue;
      }
      const tags = matchPrefix(line, "- tags:");
      if (tags !== null) {
        current.tags = tags;
        continue;
      }
      const updatedAt = matchPrefix(line, "- updated:");
      if (updatedAt !== null) {
        current.updatedAt = updatedAt;
        if (!current.createdAt) current.createdAt = updatedAt;
        continue;
      }
      const value = matchPrefix(line, "- value:");
      if (value !== null) {
        inValue = true;
        if (value) current.valueLines.push(value);
        continue;
      }
      // Header / blank / unknown lines before the value are ignored.
      continue;
    }

    current.valueLines.push(line);
  }

  flush();
  return entries;
}

function serializeMemoryFile(scope: MemoryScope, entries: MemoryEntry[]): string {
  const out: string[] = [HEADERS[scope], ""];
  for (const e of entries) {
    out.push(`## ${e.key}`);
    out.push(`- category: ${e.category || "general"}`);
    out.push(`- tags: ${e.tags}`);
    out.push(`- updated: ${e.updatedAt || e.createdAt || new Date().toISOString()}`);
    out.push(`- value: ${e.value}`);
    out.push("");
  }
  return out.join("\n");
}

function loadEntries(file: string): MemoryEntry[] {
  return parseMemoryFile(readFileSafe(file));
}

function writeEntries(file: string, scope: MemoryScope, entries: MemoryEntry[]): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, serializeMemoryFile(scope, entries), "utf-8");
}

// ── Keyword helpers ──

function entryMatches(entry: MemoryEntry, q: string): boolean {
  return (
    entry.key.toLowerCase().includes(q) ||
    entry.value.toLowerCase().includes(q) ||
    entry.category.toLowerCase().includes(q) ||
    entry.tags.toLowerCase().includes(q)
  );
}

function snippet(content: string, query: string, radius = 160): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return (prefix + content.slice(start, end).replace(/\s+/g, " ").trim() + suffix).trim();
}

// ── Store ──

export class MemoryStore {
  constructor() {
    ensureDir(MEMORY_DIR);
    ensureDir(PROJECTS_DIR);
  }

  /** Store or update a memory. `scope` selects user_profile.md vs project_memory.md. */
  remember(
    projectRoot: string,
    key: string,
    value: string,
    category: string,
    tags: string[],
    scope: MemoryScope,
  ): void {
    const file = scope === "user" ? USER_PROFILE_FILE : projectMemoryFile(projectRoot);
    const entries = loadEntries(file);
    const now = new Date().toISOString();
    const tagStr = tags.join(", ");
    const idx = entries.findIndex((e) => e.key === key);

    if (idx >= 0) {
      entries[idx] = { ...entries[idx], value, category, tags: tagStr, updatedAt: now };
    } else {
      entries.push({ key, value, category, tags: tagStr, createdAt: now, updatedAt: now });
    }

    writeEntries(file, scope, entries);
  }

  /** Retrieve a memory by exact key (searches user profile first, then project). */
  recallByKey(projectRoot: string, key: string): MemoryEntry | undefined {
    const userEntries = loadEntries(USER_PROFILE_FILE);
    const found = userEntries.find((e) => e.key === key);
    if (found) return found;
    return loadEntries(projectMemoryFile(projectRoot)).find((e) => e.key === key);
  }

  /** Keyword search over structured memories plus topics/session files. */
  searchByKeyword(projectRoot: string, query: string, limit = 5): MemorySearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: MemorySearchResult[] = [];

    for (const entry of this.allEntries(projectRoot)) {
      if (entryMatches(entry, q)) {
        results.push({ ...entry, score: 1.0 });
      }
    }

    for (const raw of grepProjectFiles(projectRoot, query, limit * 2)) {
      results.push(raw);
    }

    results.sort((a, b) => b.score - a.score || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    return results.slice(0, limit);
  }

  /** Delete a memory by key (from whichever scope it lives in). */
  forget(projectRoot: string, key: string): boolean {
    const userEntries = loadEntries(USER_PROFILE_FILE);
    const userIdx = userEntries.findIndex((e) => e.key === key);
    if (userIdx >= 0) {
      userEntries.splice(userIdx, 1);
      writeEntries(USER_PROFILE_FILE, "user", userEntries);
      return true;
    }

    const projFile = projectMemoryFile(projectRoot);
    const projEntries = loadEntries(projFile);
    const projIdx = projEntries.findIndex((e) => e.key === key);
    if (projIdx >= 0) {
      projEntries.splice(projIdx, 1);
      writeEntries(projFile, "project", projEntries);
      return true;
    }

    return false;
  }

  /** List all structured memories (user + project), newest first. */
  list(projectRoot: string): MemoryEntry[] {
    return this.allEntries(projectRoot).sort((a, b) =>
      (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt),
    );
  }

  /** Total structured memory count (user + project). */
  count(projectRoot: string): number {
    return this.allEntries(projectRoot).length;
  }

  /** Append a message-level event to the current session's JSONL log. */
  appendSession(projectRoot: string, sessionId: string, event: Record<string, unknown>): void {
    try {
      const file = sessionFile(projectRoot, sessionId);
      ensureDir(path.dirname(file));
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
      fs.appendFileSync(file, line + "\n", "utf-8");
    } catch {
      // Session logging is best-effort and must never break the agent loop.
    }
  }

  /** Append a topic-level note to today's topics.md. */
  appendTopics(projectRoot: string, markdown: string): void {
    try {
      const file = topicsFile(projectRoot);
      ensureDir(path.dirname(file));
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "# Topics\n\n", "utf-8");
      }
      fs.appendFileSync(file, markdown, "utf-8");
    } catch {
      // Topic logging is best-effort and must never break the agent loop.
    }
  }

  private allEntries(projectRoot: string): MemoryEntry[] {
    return [...loadEntries(USER_PROFILE_FILE), ...loadEntries(projectMemoryFile(projectRoot))];
  }
}

/** Bounded grep over topics.md and session_memory_*.jsonl under a project. */
function grepProjectFiles(projectRoot: string, query: string, limit: number): MemorySearchResult[] {
  const q = query.toLowerCase();
  const results: MemorySearchResult[] = [];
  const projDir = projectDir(projectRoot);
  if (!fs.existsSync(projDir)) return results;

  let dateDirs: string[] = [];
  try {
    dateDirs = fs
      .readdirSync(projDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
      .slice(0, 20);
  } catch {
    return results;
  }

  for (const dateName of dateDirs) {
    const dir = path.join(projDir, dateName);

    const topicsPath = path.join(dir, "topics.md");
    if (fs.existsSync(topicsPath)) {
      const content = readFileSafe(topicsPath);
      if (content.toLowerCase().includes(q)) {
        results.push({
          key: `${dateName}/topics.md`,
          value: snippet(content, query),
          category: "topic",
          tags: "",
          createdAt: fileMtimeIso(topicsPath),
          score: 0.8,
        });
      }
    }

    let sessionFiles: string[] = [];
    try {
      sessionFiles = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("session_memory_") && f.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      // ignore
    }

    for (const f of sessionFiles.slice(0, 20)) {
      const fp = path.join(dir, f);
      const content = readFileSafe(fp);
      if (content.toLowerCase().includes(q)) {
        results.push({
          key: `${dateName}/${f}`,
          value: snippet(content, query),
          category: "session",
          tags: "",
          createdAt: fileMtimeIso(fp),
          score: 0.6,
        });
      }
    }

    if (results.length >= limit) break;
  }

  return results;
}

// ── Global singleton ──

let store: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!store) {
    store = new MemoryStore();
  }
  return store;
}

export function closeMemoryStore(): void {
  store = null;
}
