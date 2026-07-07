// ── Persistent Memory Store ──
// SQLite-backed storage for key decisions, user preferences, and project
// conventions. Supports keyword search and (optionally) embedding-based
// semantic search via DeepSeek embeddings API.
//
// Database file: ~/.harness/memory.db (global, not in project dir)

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";

// ── Types ──

export interface MemoryEntry {
  id: number;
  key: string;
  value: string;
  category: string;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;
}

// ── Memory Store ──

export class MemoryStore {
  private db: Database.Database;

  constructor() {
    const dir = path.resolve(os.homedir(), ".harness");
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "memory.db");

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        tags TEXT NOT NULL DEFAULT '',
        embedding BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    `);
  }

  /** Store or update a memory entry. Returns the row id. */
  remember(key: string, value: string, category?: string, tags?: string[], embedding?: Float32Array): number {
    const cat = category || "general";
    const tagStr = tags ? tags.join(",") : "";
    const embBuf = embedding ? Buffer.from(embedding.buffer) : null;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    const existing = this.db.prepare("SELECT id FROM memories WHERE key = ?").get(key) as { id: number } | undefined;

    if (existing) {
      const stmt = embBuf
        ? this.db.prepare("UPDATE memories SET value = ?, category = ?, tags = ?, embedding = ?, updated_at = ? WHERE key = ?")
        : this.db.prepare("UPDATE memories SET value = ?, category = ?, tags = ?, updated_at = ? WHERE key = ?");
      const params = embBuf
        ? [value, cat, tagStr, embBuf, now, key]
        : [value, cat, tagStr, now, key];
      stmt.run(...params);
      return existing.id;
    } else {
      const stmt = embBuf
        ? this.db.prepare("INSERT INTO memories (key, value, category, tags, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        : this.db.prepare("INSERT INTO memories (key, value, category, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      const params = embBuf
        ? [key, value, cat, tagStr, embBuf, now, now]
        : [key, value, cat, tagStr, now, now];
      const result = stmt.run(...params);
      return Number(result.lastInsertRowid);
    }
  }

  /** Search memories by keyword match (case-insensitive) on key, value, tags, category. */
  searchByKeyword(query: string, limit = 5): MemorySearchResult[] {
    const q = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT *, 1.0 AS score FROM memories
      WHERE key LIKE ? OR value LIKE ? OR tags LIKE ? OR category LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(q, q, q, q, limit) as MemorySearchResult[];
    return rows;
  }

  /** Search memories by embedding similarity (cosine). Requires embeddings to be stored. */
  searchByEmbedding(queryEmbedding: Float32Array, limit = 5): MemorySearchResult[] {
    const all = this.db.prepare("SELECT * FROM memories WHERE embedding IS NOT NULL").all() as (MemoryEntry & { embedding: Buffer })[];
    if (all.length === 0) return [];

    const results: MemorySearchResult[] = all.map((row) => {
      const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
      return { ...row, score: cosineSimilarity(queryEmbedding, emb), embedding: undefined as any };
    });

    results.sort((a, b) => b.score - a.score);
    // Only return results with a meaningful similarity (above noise floor)
    return results.filter((r) => r.score > 0.3).slice(0, limit);
  }

  /** Retrieve a memory by exact key. */
  recallByKey(key: string): MemoryEntry | undefined {
    const row = this.db.prepare("SELECT id, key, value, category, tags, created_at, updated_at FROM memories WHERE key = ?").get(key) as MemoryEntry | undefined;
    return row;
  }

  /** Delete a memory by key. Returns true if deleted. */
  forget(key: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE key = ?").run(key);
    return result.changes > 0;
  }

  /** List all memories, optionally filtered by category. */
  list(category?: string): MemoryEntry[] {
    if (category) {
      return this.db.prepare("SELECT id, key, value, category, tags, created_at, updated_at FROM memories WHERE category = ? ORDER BY updated_at DESC").all(category) as MemoryEntry[];
    }
    return this.db.prepare("SELECT id, key, value, category, tags, created_at, updated_at FROM memories ORDER BY updated_at DESC").all() as MemoryEntry[];
  }

  /** Count total stored memories. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
    return row.cnt;
  }

  /** Check if any memories have embeddings (indicates embedding generation was used). */
  hasEmbeddings(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE embedding IS NOT NULL").get() as { cnt: number };
    return row.cnt > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

// ── Cosine similarity ──

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
  if (store) {
    store.close();
    store = null;
  }
}
