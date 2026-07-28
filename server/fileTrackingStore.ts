// ── File Tracking Metadata Store ──
// Lightweight JSON-file-backed cache for file watcher metadata when Git is
// not available. Uses an in-memory Map that flushes to disk on every write.
// File: ~/.harness/store/file-tracking.json

import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { FILE_TRACKING_FILE } from "./harnessPaths";

// ── Types ──

export interface FileMeta {
  path: string;
  mtime: number;
  size: number;
  checksum: string;
  isDirectory: boolean;
}

interface JsonPayload {
  workspace: string;
  files: Record<string, { m: number; s: number; d: boolean }>;
}

// ── Store ──

export class FileTrackingStore {
  private cache = new Map<string, FileMeta>();
  private dataFile: string;
  private workspacePath = "";
  private dirty = false;

  constructor() {
    fs.mkdirSync(path.dirname(FILE_TRACKING_FILE), { recursive: true });
    this.dataFile = FILE_TRACKING_FILE;
    this.load();
  }

  /** Compute a fast checksum from mtime + size. */
  static fastChecksum(mtime: number, size: number): string {
    return crypto
      .createHash("md5")
      .update(`${mtime}:${size}`)
      .digest("hex");
  }

  /** Set the workspace (used to scope the JSON file on disk). */
  setWorkspace(ws: string): void {
    this.workspacePath = ws;
  }

  /** Insert or update a file metadata record. */
  upsert(filePath: string, mtime: number, size: number, isDirectory: boolean): void {
    const checksum = FileTrackingStore.fastChecksum(mtime, size);
    this.cache.set(filePath, { path: filePath, mtime, size, checksum, isDirectory });
    this.dirty = true;
  }

  /** Get metadata for a single file. */
  get(filePath: string): FileMeta | null {
    return this.cache.get(filePath) ?? null;
  }

  /** Check if a file has changed since last recorded state. */
  hasChanged(filePath: string, currentMtime: number, currentSize: number): boolean {
    const existing = this.cache.get(filePath);
    if (!existing) return true;
    const currentChecksum = FileTrackingStore.fastChecksum(currentMtime, currentSize);
    return existing.checksum !== currentChecksum;
  }

  /** Remove a file from the cache (for deleted files). */
  remove(filePath: string): void {
    if (this.cache.delete(filePath)) {
      this.dirty = true;
    }
  }

  /** Get all tracked file paths under a directory. */
  listUnder(dirPath: string): FileMeta[] {
    const prefix = dirPath.replace(/\\/g, "/");
    const results: FileMeta[] = [];
    for (const meta of this.cache.values()) {
      if (meta.path.replace(/\\/g, "/").startsWith(prefix)) {
        results.push(meta);
      }
    }
    return results;
  }

  /** Clear all cached metadata for a directory. */
  clearDirectory(dirPath: string): void {
    const prefix = dirPath.replace(/\\/g, "/");
    for (const key of this.cache.keys()) {
      if (key.replace(/\\/g, "/").startsWith(prefix)) {
        this.cache.delete(key);
        this.dirty = true;
      }
    }
  }

  /** Clear all cached metadata. */
  clearAll(): void {
    if (this.cache.size > 0) {
      this.cache.clear();
      this.dirty = true;
    }
  }

  /** Number of tracked entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Persist in-memory cache to the JSON file on disk. */
  flush(): void {
    if (!this.dirty) return;
    try {
      const files: Record<string, { m: number; s: number; d: boolean }> = {};
      for (const [key, meta] of this.cache) {
        files[key] = { m: meta.mtime, s: meta.size, d: meta.isDirectory };
      }
      const payload: JsonPayload = { workspace: this.workspacePath, files };
      fs.writeFileSync(this.dataFile, JSON.stringify(payload), "utf-8");
      this.dirty = false;
    } catch {
      // Non-fatal — will retry on next flush or shutdown
    }
  }

  /** Load the JSON file into memory. */
  private load(): void {
    try {
      if (!fs.existsSync(this.dataFile)) return;
      const raw = fs.readFileSync(this.dataFile, "utf-8");
      const payload: JsonPayload = JSON.parse(raw);
      this.workspacePath = payload.workspace || "";
      for (const [key, val] of Object.entries(payload.files || {})) {
        this.cache.set(key, {
          path: key,
          mtime: val.m,
          size: val.s,
          checksum: FileTrackingStore.fastChecksum(val.m, val.s),
          isDirectory: !!val.d,
        });
      }
    } catch {
      // Corrupt file — start fresh
      this.cache.clear();
    }
  }

  /** Close / flush. */
  close(): void {
    this.flush();
  }
}

let store: FileTrackingStore | null = null;

export function getFileTrackingStore(): FileTrackingStore {
  if (!store) store = new FileTrackingStore();
  return store;
}

export function closeFileTrackingStore(): void {
  if (store) {
    store.close();
    store = null;
  }
}
