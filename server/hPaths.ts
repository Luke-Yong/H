// ── Centralised .h/ directory paths ──
// All persistent and runtime files live under ~/.h/ organised into
// subdirectories: store/ (persistent data), ports/ (runtime discovery),
// snapshots/ (knowledge graph exports).

import path from "path";
import os from "os";

const H_DIR = path.join(os.homedir(), ".h");

export const STORE_DIR = path.join(H_DIR, "store");
// ── Ports ──
// Use tmpdir to avoid sandbox permission issues on some machines
export const PORTS_DIR = path.join(os.tmpdir(), "h-ports");
export const SNAPSHOTS_DIR = path.join(H_DIR, "snapshots");

// ── Machine key (auto-generated, used for api-keys encryption) ──
export const H_KEY_FILE = path.join(H_DIR, ".key");

// ── Store ──
export const API_KEYS_FILE = path.join(STORE_DIR, "api-keys.enc");
export const CLIENT_STATE_FILE = path.join(STORE_DIR, "client-state.json");
export const FILE_TRACKING_FILE = path.join(STORE_DIR, "file-tracking.json");

// ── Memory (file-based, Trae-style layout) ──
// ~/.h/memory/
//   user_profile.md
//   projects/<project-slug>/project_memory.md
//   projects/<project-slug>/<YYYYMMDD>/session_memory_<sessionId>.jsonl
//   projects/<project-slug>/<YYYYMMDD>/topics.md
export const MEMORY_DIR = path.join(H_DIR, "memory");
export const USER_PROFILE_FILE = path.join(MEMORY_DIR, "user_profile.md");
export const PROJECTS_DIR = path.join(MEMORY_DIR, "projects");

// ── Ports ──
export const EXPRESS_PORT_FILE = path.join(PORTS_DIR, "express-port");
export const VITE_PORT_FILE = path.join(PORTS_DIR, "vite-port");

// ── Snapshots ──
export function getSnapshotPath(hash: string): string {
  return path.join(SNAPSHOTS_DIR, `file-tree-snapshot-${hash}.kg`);
}
export function getVizPath(hash: string): string {
  return path.join(SNAPSHOTS_DIR, `file-tree-snapshot-${hash}.txt`);
}
