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
import { generateEmbedding } from "./deepseek";

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

/** Create a memory file with its header if it does not exist yet. */
function ensureMemoryFile(file: string, scope: MemoryScope): void {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, HEADERS[scope] + "\n\n", "utf-8");
    }
  } catch {
    // Best-effort — must never break the agent loop.
  }
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
    // Materialize the cross-project profile so it exists even before the first
    // memory is stored (Trae layout: user_profile.md is always present).
    ensureMemoryFile(USER_PROFILE_FILE, "user");
  }

  /** Store or update a memory. `scope` selects user_profile.md vs project_memory.md.
   *  Near-duplicate keys are merged via `normalizeKey`; overwriting an existing
   *  value appends the old value to a history.jsonl next to the memory file. */
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
    const nKey = normalizeKey(key);

    let targetIdx = entries.findIndex((e) => e.key === key);
    if (targetIdx < 0) {
      // Merge near-duplicates: same normalized key is treated as the same memory.
      targetIdx = entries.findIndex((e) => normalizeKey(e.key) === nKey);
    }

    if (targetIdx >= 0) {
      const prev = entries[targetIdx];
      if (prev.value !== value) {
        appendHistory(path.dirname(file), {
          key: prev.key, scope, old: prev.value, next: value,
          ts: now, category: prev.category,
        });
      }
      entries[targetIdx] = { ...prev, value, category, tags: tagStr, updatedAt: now };
    } else {
      entries.push({ key, value, category, tags: tagStr, createdAt: now, updatedAt: now });
    }

    writeEntries(file, scope, entries);
    invalidateEmbeddingCache(scope, key, nKey);
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
      invalidateEmbeddingCache("user");
      return true;
    }

    const projFile = projectMemoryFile(projectRoot);
    const projEntries = loadEntries(projFile);
    const projIdx = projEntries.findIndex((e) => e.key === key);
    if (projIdx >= 0) {
      projEntries.splice(projIdx, 1);
      writeEntries(projFile, "project", projEntries);
      invalidateEmbeddingCache("project");
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
      ensureMemoryFile(projectMemoryFile(projectRoot), "project");
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
      ensureMemoryFile(projectMemoryFile(projectRoot), "project");
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

  /** Persist a pending-todo list so an interrupted turn can be resumed later. */
  persistPendingTodos(projectRoot: string, sessionId: string, todos: Array<{ id: string; text: string; status: string }>): void {
    try {
      if (!todos || todos.length === 0) return;
      this.appendSession(projectRoot, sessionId, { type: "pending_todos", todos });
      this.appendTopics(
        projectRoot,
        `## Pending tasks (interrupted turn)\n\n${todos.map((t) => `- [${t.status}] ${t.text}`).join("\n")}\n\n`,
      );
    } catch {
      // Best-effort — must never break the agent loop.
    }
  }

  /** Read the most recent persisted pending-todo list for a session. */
  loadPendingTodos(projectRoot: string, sessionId: string): Array<{ id: string; text: string; status: string }> | null {
    const file = sessionFile(projectRoot, sessionId);
    let last: Array<{ id: string; text: string; status: string }> | null = null;
    try {
      const lines = readFileSafe(file).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "pending_todos" && Array.isArray(obj.todos) && obj.todos.length > 0) {
            last = obj.todos.map((t: any) => ({
              id: String(t?.id || ""),
              text: String(t?.text || ""),
              status: String(t?.status || "pending"),
            }));
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* no file yet */ }
    return last;
  }

  private allEntries(projectRoot: string): MemoryEntry[] {
    return [...loadEntries(USER_PROFILE_FILE), ...loadEntries(projectMemoryFile(projectRoot))];
  }
}

/** Render one entry as a compact prompt line: "- key [category]: value". */
function renderEntry(e: MemoryEntry): string {
  const suffix = e.category && e.category !== "general" ? ` [${e.category}]` : "";
  return `- ${e.key}${suffix}: ${e.value.replace(/\s*\n\s*/g, " ").trim()}`;
}

/** Normalize a memory key so near-duplicates ("Indent Style" vs "indent-style") merge. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-");
}

/** Append an overwrite/merge event to history.jsonl next to the memory file. */
function appendHistory(dir: string, entry: Record<string, unknown>): void {
  try {
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, "history.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* best-effort; never break the agent loop */ }
}

/**
 * Deterministic scope classifier. "user" = cross-project facts (identity,
 * global preferences); "project" = codebase-specific details. Returns null
 * when ambiguous so the caller falls back to the explicit/model-chosen scope.
 */
export function guessScope(key: string, value: string): "user" | "project" | null {
  const USER_KEY_RE = /^(name|my-?name|full-?name|timezone|tz|location|city|country|language|locale|os|platform|editor|ide|preferred-?model|email|company|role|job)\b/i;
  const USER_VALUE_RE = /(timezone|i (?:am|live in|work (?:on|with))|my (?:name|preference)|preferred (?:model|language|editor)|across projects|in general|i always (?:use|prefer))/i;
  const PROJECT_KEY_RE = /(^|\s)(src|client|server|app|backend|frontend|tests?|docs?|config|deploy|scripts?|components?|modules?|api|database|db|schema|endpoint|routes?|middleware|docker|k8s|nginx|package|repo)(?:[-/_]|\b)/i;
  const PROJECT_VALUE_RE = /(client\/|src\/|server\/|components?\/|tests?\/|docs?\/|dist\/|build\/|node_modules\/|in this (?:project|repo|codebase)|\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md)\b)/i;
  if (USER_KEY_RE.test(key)) return "user";
  if (USER_VALUE_RE.test(value)) return "user";
  if (PROJECT_KEY_RE.test(key)) return "project";
  if (PROJECT_VALUE_RE.test(value)) return "project";
  return null;
}

function renderMemoryBlock(items: Array<{ e: MemoryEntry; scope: string }>): string {
  const parts: string[] = [];
  const user = items.filter((i) => i.scope === "user").map((i) => renderEntry(i.e)).join("\n");
  if (user) parts.push(`### User Profile\n${user}`);
  const proj = items.filter((i) => i.scope === "project").map((i) => renderEntry(i.e)).join("\n");
  if (proj) parts.push(`### Project Memory\n${proj}`);
  return parts.join("\n\n");
}

/**
 * Trae-style persistent memory block for the agent's system prompt.
 * Includes the cross-project user profile plus the current project's memory,
 * injected automatically on every turn so the agent always knows the user.
 * Returns "" when no memories exist.
 */
export function getMemoryContext(projectRoot: string, maxChars = 4000): string {
  const items = [
    ...loadEntries(USER_PROFILE_FILE).map((e) => ({ e, scope: "user" as const })),
    ...loadEntries(projectMemoryFile(projectRoot)).map((e) => ({ e, scope: "project" as const })),
  ];
  const block = renderMemoryBlock(items);
  if (!block) return "";
  return block.length > maxChars ? block.slice(0, maxChars) + "\n…" : block;
}

/** User-profile-only block — used for sub-agent prompts (smaller budget). */
export function getUserProfileContext(maxChars = 1500): string {
  const items = loadEntries(USER_PROFILE_FILE).map((e) => ({ e, scope: "user" as const }));
  const block = renderMemoryBlock(items);
  if (!block) return "";
  return block.length > maxChars ? block.slice(0, maxChars) + "\n…" : block;
}

// ── Embedding cache (per-entry, invalidated when the value changes) ──
// Avoids re-embedding unchanged entries on every user turn (N+1 API calls).

const embCache = new Map<string, { hash: string; vec: Float32Array }>();

function hashOf(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex").slice(0, 16);
}

function invalidateEmbeddingCache(scope: string, key?: string, nKey?: string): void {
  if (key || nKey) {
    embCache.delete(`${scope}:${nKey || normalizeKey(key || "")}`);
    return;
  }
  embCache.clear();
}

async function getEntryEmbedding(scope: string, e: MemoryEntry, apiKey: string): Promise<Float32Array | null> {
  const cacheKey = `${scope}:${normalizeKey(e.key)}`;
  const h = hashOf(e.value);
  const cached = embCache.get(cacheKey);
  if (cached && cached.hash === h) return cached.vec;
  const vec = await generateEmbedding(`${e.key}: ${e.value.slice(0, 300)}`, apiKey);
  if (vec) embCache.set(cacheKey, { hash: h, vec });
  return vec;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank memory entries against the current user query (keyword + cached-embedding
 * hybrid) and render the top-K. Falls back to keyword-only ranking when
 * embeddings are unavailable. One embedding call for the query, zero per entry.
 */
export async function selectMemoryContext(projectRoot: string, query: string, apiKey: string, limit = 6): Promise<string> {
  const items = [
    ...loadEntries(USER_PROFILE_FILE).map((e) => ({ e, scope: "user" as const })),
    ...loadEntries(projectMemoryFile(projectRoot)).map((e) => ({ e, scope: "project" as const })),
  ];
  if (items.length === 0) return "";
  const q = (query || "").toLowerCase().trim();

  const scored = items.map(({ e, scope }) => {
    let keyword = 0;
    if (q) {
      if (e.key.toLowerCase().includes(q)) keyword += 3;
      if (e.value.toLowerCase().includes(q)) keyword += 2;
      for (const w of q.split(/\s+/)) {
        if (w.length > 2 && e.value.toLowerCase().includes(w)) keyword += 1;
        if (w.length > 2 && e.key.toLowerCase().includes(w)) keyword += 1;
      }
    }
    return { e, scope, keyword };
  });

  let ranked = scored;
  try {
    const qEmb = q ? await generateEmbedding(query, apiKey) : null;
    if (qEmb) {
      const withEmb = await Promise.all(scored.map(async (s) => {
        const v = await getEntryEmbedding(s.scope, s.e, apiKey);
        return { ...s, semantic: v ? cosine(qEmb, v) : 0 };
      }));
      ranked = withEmb
        .map((s) => ({ ...s, total: s.keyword + (s.semantic || 0) * 3 }))
        .sort((a, b) => b.total - a.total);
    }
  } catch { /* embeddings unavailable — fall back to keyword ranking */ }

  if (ranked === scored) {
    ranked = [...scored].sort((a, b) => b.keyword - a.keyword);
  }
  const block = renderMemoryBlock(ranked.slice(0, limit));
  return block.length > 4000 ? block.slice(0, 4000) + "\n…" : block;
}

// ── Automatic preference capture ──
// Conservative high-precision patterns so user_profile.md only gets explicit
// preference statements, not normal conversational sentences.

const PREFERENCE_PATTERNS: RegExp[] = [
  /\bI (?:prefer|usually use|always use|want to use|work with)\s+(.{6,140})/i,
  /\b(?:please|always|from now on|going forward)\s+(?:use|prefer|keep)\s+(.{6,140})/i,
  /\b(?:let's|we should|we'll)\s+(?:use|switch to|adopt|stick with)\s+(.{4,120})/i,
];

export function autoCapturePreference(projectRoot: string, message: string): { key: string; value: string; scope: "user" | "project" } | null {
  const msg = (message || "").slice(0, 2000);
  for (const re of PREFERENCE_PATTERNS) {
    const m = msg.match(re);
    if (!m) continue;
    const value = m[0].replace(/\s+/g, " ").trim();
    if (value.length < 10 || value.length > 180) continue; // too short = noise, too long = sentence
    const key = `pref-${normalizeKey(value.slice(0, 40))}`;
    const scope = guessScope(key, value) || "user";
    // Skip when the same normalized preference already exists — no re-writes every turn.
    const file = scope === "user" ? USER_PROFILE_FILE : projectMemoryFile(projectRoot);
    if (loadEntries(file).some((e) => normalizeKey(e.key) === normalizeKey(key))) return null;
    getMemoryStore().remember(projectRoot, key, value, "preference", [], scope);
    return { key, value, scope };
  }
  return null;
}

// ── Session-end memory maintenance ──
// Semantic de-duplication: entries that mean the same thing (cosine > 0.95)
// are merged, keeping the newest value. Runs async after an agent run.

export async function runMemoryMaintenance(projectRoot: string, _sessionId: string | undefined, apiKey: string): Promise<string> {
  const results: string[] = [];
  const scopeFiles: Array<{ scope: MemoryScope; entries: MemoryEntry[]; file: string }> = [
    { scope: "user", entries: loadEntries(USER_PROFILE_FILE), file: USER_PROFILE_FILE },
    { scope: "project", entries: loadEntries(projectMemoryFile(projectRoot)), file: projectMemoryFile(projectRoot) },
  ];

  for (const { scope, entries, file } of scopeFiles) {
    if (entries.length < 2) continue;
    const vectors = await Promise.all(entries.map((e) => getEntryEmbedding(scope, e, apiKey)));
    const removed = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      if (removed.has(entries[i].key)) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (removed.has(entries[j].key)) continue;
        const vi = vectors[i], vj = vectors[j];
        if (!vi || !vj) continue;
        if (cosine(vi, vj) > 0.95) {
          const newer = new Date(entries[i].updatedAt || entries[i].createdAt) >= new Date(entries[j].updatedAt || entries[j].createdAt)
            ? entries[i] : entries[j];
          const older = newer === entries[i] ? entries[j] : entries[i];
          appendHistory(path.dirname(file), { key: older.key, scope, mergedInto: newer.key, ts: new Date().toISOString() });
          removed.add(older.key);
          results.push(`Merged "${older.key}" into "${newer.key}" (duplicate)`);
        }
      }
    }
    if (removed.size > 0) {
      writeEntries(file, scope, entries.filter((e) => !removed.has(e.key)));
      invalidateEmbeddingCache(scope);
    }
  }

  return results.length > 0 ? `Memory maintenance: ${results.join("; ")}` : "Memory maintenance: no changes";
}

// ── Raw file access (UI editing) ──

export function getProfileRaw(scope: "user" | "project", projectRoot: string): string {
  const file = scope === "user" ? USER_PROFILE_FILE : projectMemoryFile(projectRoot);
  return readFileSafe(file);
}

export function setProfileRaw(scope: "user" | "project", projectRoot: string, content: string): void {
  const file = scope === "user" ? USER_PROFILE_FILE : projectMemoryFile(projectRoot);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf-8");
  invalidateEmbeddingCache(scope); // raw edits may change any entry — drop all cached vectors
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
