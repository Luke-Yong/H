// ── File Tracking Service ──
// Smart file tracking that auto-detects Git availability:
// - Git available  → uses Git for file tracking and checkout
// - No Git         → uses a lightweight fs.watch-based file watcher + JSON cache
// - Git installed mid-session → detects, notifies frontend, switches on confirmation
//
// Follows the pattern of modern IDEs with "workspace trust" and dynamic tool detection.

import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { getFileTrackingStore, type FileTrackingStore } from "./fileTrackingStore";

// ── Types ──

export type TrackingMode = "git" | "watcher" | "none";

export interface FileTrackingStatus {
  mode: TrackingMode;
  gitAvailable: boolean;
  gitDetectedMidSession: boolean;
  workspacePath: string;
}

export interface FileChangeEvent {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  trackingMode: TrackingMode;
}

export type FileChangeCallback = (event: FileChangeEvent) => void;

// ── Constants ──

/** Interval (ms) to check if Git has become available mid-session */
const GIT_CHECK_INTERVAL = 30_000;

/** Debounce window for write events (ms) — waits for writes to settle */
const WRITE_DEBOUNCE_MS = 300;

/** Directories that are never watched */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".env",
  "dist", ".next", "build", ".cache",
]);

// ── Lightweight fs.watch-based Watcher ──

interface WatchEntry {
  dirPath: string;
  watcher: fs.FSWatcher;
}

class FsWatcher {
  private watches = new Map<string, WatchEntry>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private callback: FileChangeCallback;
  private rootPath: string;
  private running = false;

  constructor(rootPath: string, callback: FileChangeCallback) {
    this.rootPath = path.resolve(rootPath);
    this.callback = callback;
  }

  /** Start watching the root and recursively watch subdirectories. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchDir(this.rootPath);
  }

  /** Stop all watchers and clear pending debounces. */
  stop(): void {
    this.running = false;
    for (const [, entry] of this.watches) {
      entry.watcher.close();
    }
    this.watches.clear();
    for (const [, timer] of this.pending) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  /** Add a directory to watch (called when a new dir is discovered). */
  addDir(dirPath: string): void {
    if (!this.running) return;
    this.watchDir(dirPath);
    // Also scan existing children
    this.scanDir(dirPath);
  }

  // ── Internal ──

  private watchDir(dirPath: string): void {
    if (this.watches.has(dirPath)) return;
    try {
      const watcher = fs.watch(dirPath, { persistent: true }, (_eventType, filename) => {
        if (!filename || !this.running) return;
        const fullPath = path.join(dirPath, filename);
        this.debounce(fullPath);
      });
      this.watches.set(dirPath, { dirPath, watcher });
      watcher.on("error", (err) => {
        // Directory may have been deleted — clean up
        this.watches.delete(dirPath);
        watcher.close();
      });
    } catch {
      // Directory not watchable (e.g., permissions)
    }
  }

  private debounce(filePath: string): void {
    const existing = this.pending.get(filePath);
    if (existing) clearTimeout(existing);
    this.pending.set(
      filePath,
      setTimeout(() => {
        this.pending.delete(filePath);
        this.handleChange(filePath);
      }, WRITE_DEBOUNCE_MS)
    );
  }

  private handleChange(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // Directory changed — ensure we're watching it
        if (!this.watches.has(filePath)) {
          this.watchDir(filePath);
          this.scanDir(filePath);
          this.callback({ type: "addDir", path: filePath, trackingMode: "watcher" });
        }
      } else {
        this.callback({ type: "change", path: filePath, trackingMode: "watcher" });
      }
    } catch {
      // File/dir was deleted
      this.callback({ type: "unlink", path: filePath, trackingMode: "watcher" });
      // If it was a watched directory, clean up
      const entry = this.watches.get(filePath);
      if (entry) {
        entry.watcher.close();
        this.watches.delete(filePath);
      }
    }
  }

  /** Scan a directory for children, watching new subdirectories. */
  scanDir(dirPath: string): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (!this.watches.has(fullPath)) {
          this.watchDir(fullPath);
          this.scanDir(fullPath);
        }
      }
    } catch {
      // Directory unreadable
    }
  }
}

// ── Service ──

export class FileTrackingService {
  private mode: TrackingMode = "none";
  private workspacePath = "";
  private watcher: FsWatcher | null = null;
  private store: FileTrackingStore;
  private changeCallbacks: Set<FileChangeCallback> = new Set();
  private gitCheckTimer: ReturnType<typeof setInterval> | null = null;
  private gitDetectedMidSession = false;
  private isSwitching = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Last snapshot of file paths sent to the agent (for patch-based updates). */
  private lastSentSnapshot: Set<string> | null = null;

  constructor() {
    this.store = getFileTrackingStore();
  }

  // ── Public API ──

  /** Initialize the file tracking service for a workspace. */
  init(workspacePath: string): FileTrackingStatus {
    this.workspacePath = path.resolve(workspacePath);
    this.store.setWorkspace(this.workspacePath);
    // Load any persisted snapshot for this workspace (cross-session continuity)
    this.loadSnapshot();
    const gitAvailable = FileTrackingService.checkGitAvailable();

    if (gitAvailable) {
      this.startGitMode();
    } else {
      this.startWatcherMode();
    }

    // Build the initial file tree snapshot eagerly (ready before first agent run)
    this.buildSnapshot();

    // Start periodic Git availability check (only if not already in git mode)
    if (!gitAvailable) {
      this.startPeriodicGitCheck();
    }

    return this.getStatus();
  }

  /** Get current tracking status. */
  getStatus(): FileTrackingStatus {
    return {
      mode: this.mode,
      gitAvailable: this.mode === "git" || FileTrackingService.checkGitAvailable(),
      gitDetectedMidSession: this.gitDetectedMidSession,
      workspacePath: this.workspacePath,
    };
  }

  /** Subscribe to file change events. */
  onFileChange(callback: FileChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /** Get changed files (Git mode: from git status; Watcher mode: from cache comparison). */
  getChangedFiles(): string[] {
    if (this.mode === "git") {
      return this.getGitChangedFiles();
    }
    if (this.mode === "watcher") {
      return this.getWatcherChangedFiles();
    }
    return [];
  }

  /** Refresh file tree by re-scanning the workspace. */
  refreshFileTree(): void {
    if (this.mode === "watcher" && this.workspacePath) {
      this.scanWorkspace();
    }
  }

  /** Check if Git is available on the system (static, can be called anytime). */
  static checkGitAvailable(): boolean {
    try {
      const result = execSync("git --version", {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      });
      return result.toLowerCase().startsWith("git version");
    } catch {
      return false;
    }
  }

  /** Check if the workspace has a Git repository. */
  hasGitRepo(): boolean {
    if (!this.workspacePath) return false;
    return this.findGitRoot(this.workspacePath) !== null;
  }

  /** Find the .git directory by walking up from the given path. */
  findGitRoot(startPath: string): string | null {
    let dir = path.resolve(startPath);
    while (true) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  /** Switch from watcher mode to git mode. Compares state and resolves differences. */
  switchToGit(): { success: boolean; conflicts: string[]; message: string } {
    if (this.mode === "git") {
      return { success: true, conflicts: [], message: "Already in Git tracking mode." };
    }
    if (this.isSwitching) {
      return { success: false, conflicts: [], message: "Switch already in progress." };
    }

    if (!FileTrackingService.checkGitAvailable()) {
      return { success: false, conflicts: [], message: "Git is not available on this system." };
    }

    this.isSwitching = true;

    try {
      this.stopWatcher();
      this.stopPeriodicGitCheck();

      const needsInit = !this.findGitRoot(this.workspacePath);

      if (needsInit) {
        try {
          execSync("git init", { cwd: this.workspacePath, encoding: "utf8", timeout: 10000 });
        } catch (err: any) {
          return {
            success: false,
            conflicts: [],
            message: `Failed to initialize Git repository: ${err.message}`,
          };
        }
      }

      // Compare watcher cache with actual filesystem to find differences
      const conflicts: string[] = [];
      const cachedFiles = this.store.listUnder(this.workspacePath);
      for (const meta of cachedFiles) {
        try {
          const stat = fs.statSync(meta.path);
          if (this.store.hasChanged(meta.path, stat.mtimeMs, stat.size)) {
            conflicts.push(meta.path);
          }
        } catch {
          conflicts.push(meta.path);
        }
      }

      this.store.clearDirectory(this.workspacePath);

      if (needsInit) {
        try {
          execSync("git add -A", { cwd: this.workspacePath, encoding: "utf8", timeout: 30000 });
          const status = execSync("git status --porcelain", {
            cwd: this.workspacePath,
            encoding: "utf8",
            timeout: 5000,
          }).trim();
          if (status) {
            execSync('git commit -m "Initial commit (auto-generated by Harness)"', {
              cwd: this.workspacePath,
              encoding: "utf8",
              timeout: 10000,
            });
          }
        } catch {
          // Non-fatal
        }
      }

      this.mode = "git";
      this.gitDetectedMidSession = true;
      this.isSwitching = false;

      return {
        success: true,
        conflicts,
        message: needsInit
          ? "Git repository initialized and tracking enabled."
          : "Switched to Git-based file tracking.",
      };
    } catch (err: any) {
      this.isSwitching = false;
      try { this.startWatcherMode(); } catch { /* */ }
      return {
        success: false,
        conflicts: [],
        message: `Failed to switch to Git: ${err.message}`,
      };
    }
  }

  /** Check if Git is available in the workspace directory. */
  isGitWorkspace(): boolean {
    return this.hasGitRepo();
  }

  /** Build the initial file tree snapshot eagerly (called on folder open, before any agent run). */
  buildSnapshot(): void {
    if (!this.workspacePath) return;
    const start = Date.now();
    const files = this.collectAllFiles();
    this.lastSentSnapshot = new Set(files);
    this.saveSnapshot();
    console.log(`[FileTracking] Built initial snapshot: ${files.length} files in ${Date.now() - start}ms`);
  }

  /** Get git status for the workspace. */
  getGitStatus(): {
    ok: boolean;
    branch?: string;
    gitRoot?: string;
    staged?: Array<{ path: string; status: string }>;
    unstaged?: Array<{ path: string; status: string }>;
    error?: string;
  } {
    if (this.mode !== "git" || !this.workspacePath) {
      return { ok: false, error: "Not in Git tracking mode." };
    }
    try {
      const cwd = this.findGitRoot(this.workspacePath) || this.workspacePath;
      const statusRaw = execSync("git status --porcelain -u", {
        cwd,
        encoding: "utf8",
        timeout: 5000,
      });
      const lines = statusRaw.trim().split(/\r?\n/).filter(Boolean);
      const staged: Array<{ path: string; status: string }> = [];
      const unstaged: Array<{ path: string; status: string }> = [];
      for (const line of lines) {
        const idx = line.substring(0, 2);
        const file = line.substring(3).trim();
        const stageStatus = idx[0];
        const workStatus = idx[1];
        if (stageStatus !== " ")
          staged.push({
            path: file,
            status: `${stageStatus}${workStatus !== " " ? workStatus : ""}`,
          });
        if (workStatus !== " ") unstaged.push({ path: file, status: workStatus });
        if (stageStatus === " " && workStatus === " ")
          unstaged.push({ path: file, status: "U" });
      }
      let branch = "";
      try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd,
          encoding: "utf8",
          timeout: 3000,
        }).trim();
      } catch {
        branch = "unknown";
      }
      let gitRoot = "";
      try {
        gitRoot = execSync("git rev-parse --show-toplevel", {
          cwd,
          encoding: "utf8",
          timeout: 3000,
        }).trim();
      } catch {
        /* */
      }
      return { ok: true, branch, gitRoot: gitRoot || cwd, staged, unstaged };
    } catch (err: any) {
      return { ok: false, error: err?.message || "Not a git repository" };
    }
  }

  /** Clean up all resources. */
  destroy(): void {
    this.stopWatcher();
    this.stopPeriodicGitCheck();
    this.stopFlushTimer();
    this.saveSnapshot();
    this.store.flush();
    this.changeCallbacks.clear();
  }

  // ── File Tree Context (for agent system prompt) ──

  /**
   * Get file tree context for the agent.
   * - First call or after reset: returns the full recursive file tree.
   * - Subsequent calls: returns only patches (added/deleted files) since last call.
   * The last-sent snapshot persists to disk for cross-session continuity.
   */
  getFileTreeContext(): { text: string; isFull: boolean } {
    if (!this.workspacePath) return { text: "", isFull: false };

    const currentFiles = this.collectAllFiles();

    if (!this.lastSentSnapshot || this.lastSentSnapshot.size === 0) {
      // First time — send full tree
      this.lastSentSnapshot = new Set(currentFiles);
      this.saveSnapshot();
      return { text: this.formatFullTree(currentFiles), isFull: true };
    }

    // Compute patches
    const added: string[] = [];
    const deleted: string[] = [];
    const currentSet = new Set(currentFiles);

    for (const f of currentFiles) {
      if (!this.lastSentSnapshot.has(f)) added.push(f);
    }
    for (const f of this.lastSentSnapshot) {
      if (!currentSet.has(f)) deleted.push(f);
    }

    // If the diff is too large (e.g. after git checkout of a different branch),
    // send a full tree instead of a massive patch.
    if (added.length + deleted.length > 100) {
      this.lastSentSnapshot = currentSet;
      this.saveSnapshot();
      return { text: this.formatFullTree(currentFiles), isFull: true };
    }

    // Update snapshot for next time
    this.lastSentSnapshot = currentSet;
    this.saveSnapshot();

    if (added.length === 0 && deleted.length === 0) {
      return { text: "(no file tree changes since last update)", isFull: false };
    }

    return { text: this.formatPatch(added, deleted), isFull: false };
  }

  /** Force the next call to getFileTreeContext() to send a full snapshot. */
  resetFileTreeSnapshot(): void {
    this.lastSentSnapshot = null;
    const fp = this.getSnapshotPath();
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
  }

  // ── Private: Snapshot Persistence ──

  /** Derive a workspace-specific snapshot filename from the workspace path. */
  private getSnapshotPath(): string {
    const dir = path.resolve(os.homedir(), ".harness");
    const hash = crypto.createHash("md5").update(this.workspacePath).digest("hex").slice(0, 12);
    return path.join(dir, `file-tree-snapshot-${hash}.json`);
  }

  private loadSnapshot(): void {
    if (!this.workspacePath) return;
    try {
      const fp = this.getSnapshotPath();
      if (!fs.existsSync(fp)) return;
      const raw = fs.readFileSync(fp, "utf-8");
      const arr: string[] = JSON.parse(raw);
      this.lastSentSnapshot = new Set(arr);
    } catch {
      this.lastSentSnapshot = null;
    }
  }

  private saveSnapshot(): void {
    try {
      const fp = this.getSnapshotPath();
      const arr = this.lastSentSnapshot ? [...this.lastSentSnapshot] : [];
      fs.writeFileSync(fp, JSON.stringify(arr), "utf-8");
    } catch { /* non-fatal */ }
  }

  // ── Private: File Collection ──

  /** Recursively collect all file paths in the workspace. */
  private collectAllFiles(): string[] {
    const results: string[] = [];
    if (!this.workspacePath || !fs.existsSync(this.workspacePath)) return results;

    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              walk(fullPath);
            } else {
              results.push(fullPath);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dir */ }
    };

    walk(this.workspacePath);
    results.sort();
    return results;
  }

  private formatFullTree(files: string[]): string {
    if (files.length === 0) return "### Project File Tree (full)\n(empty project)";
    const root = this.workspacePath.replace(/\\/g, "/");
    const relFiles = files.map((f) => f.replace(/\\/g, "/").replace(root + "/", ""));
    const dirs = new Set<string>();
    const treeLines: string[] = [];

    // Build a compact tree structure
    for (const rf of relFiles) {
      const parts = rf.split("/");
      // Register all parent directories
      for (let i = 0; i < parts.length - 1; i++) {
        dirs.add(parts.slice(0, i + 1).join("/") + "/");
      }
      treeLines.push(rf);
    }

    const allSorted = [...dirs].sort().concat(treeLines.sort());
    const body = allSorted
      .map((l) => (l.endsWith("/") ? `  ${l}` : `  ${l}`))
      .join("\n");

    const truncated = allSorted.length > 200
      ? body.split("\n").slice(0, 200).join("\n") + `\n  ... and ${allSorted.length - 200} more entries`
      : body;

    return `### Project File Tree (full — ${files.length} files)\n${truncated}`;
  }

  private formatPatch(added: string[], deleted: string[]): string {
    const root = this.workspacePath.replace(/\\/g, "/");
    const rel = (p: string) => p.replace(/\\/g, "/").replace(root + "/", "");
    const lines: string[] = [];
    lines.push(`### File Tree Changes (patch)`);
    if (added.length > 0) {
      lines.push(`Added (${added.length}):`);
      for (const f of added.slice(0, 50)) lines.push(`  + ${rel(f)}`);
      if (added.length > 50) lines.push(`  ... and ${added.length - 50} more`);
    }
    if (deleted.length > 0) {
      lines.push(`Deleted (${deleted.length}):`);
      for (const f of deleted.slice(0, 50)) lines.push(`  - ${rel(f)}`);
      if (deleted.length > 50) lines.push(`  ... and ${deleted.length - 50} more`);
    }
    return lines.join("\n");
  }

  // ── Private: Git Mode ──

  private startGitMode(): void {
    this.mode = "git";
    this.stopWatcher();
    this.stopPeriodicGitCheck();
    console.log(`[FileTracking] Git mode active for ${this.workspacePath}`);
  }

  // ── Private: Watcher Mode ──

  private startWatcherMode(): void {
    if (!this.workspacePath) return;

    this.mode = "watcher";

    // Do an initial full scan to populate the cache
    this.scanWorkspace();

    // Start the lightweight fs.watch-based watcher
    try {
      this.watcher = new FsWatcher(this.workspacePath, (event) => {
        this.handleFsEvent(event.type, event.path);
      });
      this.watcher.start();
      // Also scan existing subdirectories to start watching them
      this.watcher.addDir(this.workspacePath);

      // Start periodic flush of JSON cache (every 10s)
      this.startFlushTimer();

      console.log(`[FileTracking] Watcher mode active for ${this.workspacePath}`);
    } catch (err) {
      console.error("[FileTracking] Failed to start watcher:", err);
      this.mode = "none";
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    this.stopFlushTimer();
    this.store.flush();
  }

  /** Recursively scan workspace to populate the metadata cache. */
  private scanWorkspace(): void {
    if (!this.workspacePath || !fs.existsSync(this.workspacePath)) return;

    const startTime = Date.now();
    let count = 0;

    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            this.store.upsert(fullPath, stat.mtimeMs, stat.size, entry.isDirectory());
            count++;
            if (entry.isDirectory()) {
              walk(fullPath);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    walk(this.workspacePath);
    console.log(`[FileTracking] Scanned ${count} files in ${Date.now() - startTime}ms`);
  }

  private handleFsEvent(type: FileChangeEvent["type"], filePath: string): void {
    try {
      if (type === "unlink" || type === "unlinkDir") {
        this.store.remove(filePath);
      } else {
        const stat = fs.statSync(filePath);
        this.store.upsert(filePath, stat.mtimeMs, stat.size, stat.isDirectory());
      }
    } catch {
      if (type !== "unlink" && type !== "unlinkDir") {
        this.store.remove(filePath);
      }
    }

    // Forward to external subscribers
    const event: FileChangeEvent = { type, path: filePath, trackingMode: this.mode };
    for (const cb of this.changeCallbacks) {
      try { cb(event); } catch { /* */ }
    }
  }

  // ── Private: Change Detection ──

  private getGitChangedFiles(): string[] {
    try {
      const cwd = this.findGitRoot(this.workspacePath) || this.workspacePath;
      const raw = execSync("git status --porcelain -u", {
        cwd,
        encoding: "utf8",
        timeout: 5000,
      });
      return raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const file = line.substring(3).trim();
          return path.isAbsolute(file) ? file : path.join(cwd, file);
        });
    } catch {
      return [];
    }
  }

  private getWatcherChangedFiles(): string[] {
    const cached = this.store.listUnder(this.workspacePath);
    const changed: string[] = [];
    for (const meta of cached) {
      try {
        const stat = fs.statSync(meta.path);
        if (meta.mtime !== stat.mtimeMs || meta.size !== stat.size) {
          changed.push(meta.path);
        }
      } catch {
        changed.push(meta.path);
      }
    }
    return changed;
  }

  // ── Private: Periodic Git Check ──

  private startPeriodicGitCheck(): void {
    if (this.gitCheckTimer) return;
    this.gitCheckTimer = setInterval(() => {
      if (this.mode !== "watcher") {
        this.stopPeriodicGitCheck();
        return;
      }
      const gitAvailable = FileTrackingService.checkGitAvailable();
      if (gitAvailable && !this.gitDetectedMidSession) {
        this.gitDetectedMidSession = true;
        console.log("[FileTracking] Git detected mid-session!");
        for (const cb of this.changeCallbacks) {
          try {
            cb({ type: "change", path: this.workspacePath, trackingMode: this.mode });
          } catch { /* */ }
        }
      }
    }, GIT_CHECK_INTERVAL);
  }

  private stopPeriodicGitCheck(): void {
    if (this.gitCheckTimer) {
      clearInterval(this.gitCheckTimer);
      this.gitCheckTimer = null;
    }
  }

  // ── Private: JSON Flush Timer ──

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.store.flush();
    }, 10_000);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ── Singleton ──

let service: FileTrackingService | null = null;

export function getFileTrackingService(): FileTrackingService {
  if (!service) service = new FileTrackingService();
  return service;
}

export function closeFileTrackingService(): void {
  if (service) {
    service.destroy();
    service = null;
  }
}
