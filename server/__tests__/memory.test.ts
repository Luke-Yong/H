import { describe, it, expect, beforeAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// Isolate the memory store to a temp HOME so tests never touch the real ~/.h/.
// memory.ts resolves MEMORY_DIR via os.homedir() at import time, so set the env
// BEFORE the (dynamic) import below.
const TEST_HOME = path.join(os.tmpdir(), `h-memory-test-${Date.now()}`);

let memory: typeof import("../memory");

beforeAll(async () => {
  process.env.USERPROFILE = TEST_HOME;
  process.env.HOME = TEST_HOME;
  process.env.HOMEDRIVE = path.parse(TEST_HOME).root;
  process.env.HOMEPATH = TEST_HOME.slice(path.parse(TEST_HOME).root.length);
  fs.mkdirSync(TEST_HOME, { recursive: true });
  memory = await import("../memory");
});

const normalizeKey = (k: string) => memory.normalizeKey(k);
const guessScope = (k: string, v: string) => memory.guessScope(k, v);
const autoCapturePreference = (root: string, msg: string) => memory.autoCapturePreference(root, msg);
const getMemoryStore = () => memory.getMemoryStore();
const getProfileRaw = (scope: "user" | "project", root: string) => memory.getProfileRaw(scope, root);

describe("normalizeKey", () => {
  it("merges case/separator variants", () => {
    expect(normalizeKey("Indent Style")).toBe("indent-style");
    expect(normalizeKey("indent-style")).toBe("indent-style");
    expect(normalizeKey("UI Framework!")).toBe("ui-framework");
    expect(normalizeKey("apiAuthMethod")).toBe("apiauthmethod");
  });
});

describe("guessScope", () => {
  it("classifies identity/global facts as user", () => {
    expect(guessScope("timezone", "Asia/Singapore")).toBe("user");
    expect(guessScope("preferred-model", "deepseek-chat")).toBe("user");
    expect(guessScope("language", "python")).toBe("user");
    expect(guessScope("anything", "I always use tabs")).toBe("user");
  });
  it("classifies codebase-specific facts as project", () => {
    expect(guessScope("api-auth-method", "JWT in Authorization header")).toBe("project");
    expect(guessScope("ui-framework", "React inside client/src")).toBe("project");
    expect(guessScope("server-port", "3000")).toBe("project");
  });
  it("returns null when ambiguous", () => {
    expect(guessScope("indent-style", "tabs over spaces")).toBeNull();
  });
});

describe("remember — dedup + history", () => {
  it("merges near-duplicate keys and logs the old value", () => {
    const store = getMemoryStore();
    const root = TEST_HOME;

    store.remember(root, "Indent Style", "tabs over spaces", "preference", [], "user");
    // Same normalized key, different spelling → merges into the existing entry.
    store.remember(root, "indent-style", "4 spaces now", "preference", ["styling"], "user");

    const all = store.list(root);
    const entry = all.find((e) => normalizeKey(e.key) === "indent-style");
    expect(all.filter((e) => normalizeKey(e.key) === "indent-style")).toHaveLength(1);
    expect(entry?.value).toBe("4 spaces now");
    expect(entry?.tags).toContain("styling");

    // Old value must be recorded in history.jsonl next to the memory file.
    const historyPath = path.join(TEST_HOME, ".h", "memory", "history.jsonl");
    expect(fs.existsSync(historyPath)).toBe(true);
    const lines = fs.readFileSync(historyPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.key).toBe("Indent Style");
    expect(last.old).toBe("tabs over spaces");
    expect(last.next).toBe("4 spaces now");
  });
});

describe("autoCapturePreference", () => {
  it("captures explicit preferences and skips repeats", () => {
    const root = TEST_HOME;
    const cap = autoCapturePreference(root, "I prefer tabs over spaces for indentation.");
    expect(cap).not.toBeNull();
    expect(cap!.key.startsWith("pref-")).toBe(true);
    expect(cap!.scope).toBe("user");

    // Same normalized statement again → no duplicate write.
    expect(autoCapturePreference(root, "I prefer tabs over spaces for indentation.")).toBeNull();

    // Normal conversational sentences must NOT be captured.
    expect(autoCapturePreference(root, "Can you explain how the routing works?")).toBeNull();
    expect(autoCapturePreference(root, "This is a random message about nothing specific.")).toBeNull();
  });

  it("writes the captured value into the profile file", () => {
    const raw = getProfileRaw("user", TEST_HOME);
    expect(raw).toContain("pref-");
    expect(raw).toContain("tabs over spaces");
  });
});
