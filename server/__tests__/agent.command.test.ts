// ── Command execution tests ──
// Tests run_command, run_in_terminal, and read_command_output tools.

import { describe, it, expect } from "vitest";
import { runFsTool, clearCommandOutputs } from "../agent";
import fs from "fs";
import path from "path";
import os from "os";

describe("runFsTool - Command tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "h-cmd-"));
    clearCommandOutputs();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  describe("run_command", () => {
    it("runs a shell command and returns output", async () => {
      const result = await runFsTool("run_command", { command: "echo hello world" }, tmpDir);
      expect(result).toContain("hello world");
    }, 10000);

    it("returns [cmd #N] prefix in output", async () => {
      const result = await runFsTool("run_command", { command: "echo test123" }, tmpDir);
      expect(result).toMatch(/\[cmd #\d+\]/);
      expect(result).toContain("test123");
    }, 10000);

    it("blocks cd/pushd commands", async () => {
      const result = await runFsTool("run_command", { command: "cd /tmp" }, tmpDir);
      expect(result).toContain("Blocked");
    });

    it("blocks pushd commands", async () => {
      const result = await runFsTool("run_command", { command: "pushd C:\\" }, tmpDir);
      expect(result).toContain("Blocked");
    });

    it("blocks server start commands (python app.py)", async () => {
      const result = await runFsTool("run_command", { command: "python app.py" }, tmpDir);
      expect(result).toContain("BLOCKED");
      expect(result).toContain("run_in_terminal");
    }, 10000);

    it("blocks npm start commands", async () => {
      const result = await runFsTool("run_command", { command: "npm start" }, tmpDir);
      expect(result).toContain("BLOCKED");
      expect(result).toContain("run_in_terminal");
    }, 10000);

    it("blocks npm run dev commands", async () => {
      const result = await runFsTool("run_command", { command: "npm run dev" }, tmpDir);
      expect(result).toContain("BLOCKED");
      expect(result).toContain("run_in_terminal");
    }, 10000);

    it("blocks npx serve commands", async () => {
      const result = await runFsTool("run_command", { command: "npx serve ." }, tmpDir);
      expect(result).toContain("BLOCKED");
      expect(result).toContain("run_in_terminal");
    }, 10000);

    it("blocks vite command", async () => {
      const result = await runFsTool("run_command", { command: "vite" }, tmpDir);
      expect(result).toContain("BLOCKED");
      expect(result).toContain("run_in_terminal");
    }, 10000);

    it("allows npm install (not blocked)", async () => {
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      const result = await runFsTool("run_command", { command: "npm install --silent 2>&1" }, tmpDir);
      expect(result).not.toContain("BLOCKED");
    }, 60000);

    it("allows pip/pytest commands (not blocked)", async () => {
      const result = await runFsTool("run_command", { command: "pip --version" }, tmpDir);
      expect(result).not.toContain("BLOCKED");
    }, 15000);

    it("returns exit code for failed commands", async () => {
      const result = await runFsTool("run_command", {
        command: "node -e \"process.exit(1)\"",
      }, tmpDir);
      expect(result).toContain("Exit code 1");
    }, 10000);

    it("handles empty command output", async () => {
      const result = await runFsTool("run_command", {
        command: process.platform === "win32"
          ? "cmd /c exit /b 0"
          : "true",
      }, tmpDir);
      expect(result).toMatch(/\[cmd #\d+\]/);
    }, 10000);
  });

  describe("run_in_terminal", () => {
    it("returns null (not executed server-side)", async () => {
      const result = await runFsTool("run_in_terminal", { command: "echo test" }, tmpDir);
      expect(result).toBeNull();
    });
  });

  describe("read_command_output", () => {
    it("re-reads output from a previous command", async () => {
      // Run a command first
      await runFsTool("run_command", { command: "echo line1 && echo line2 && echo line3" }, tmpDir);
      // Read back the output
      const result = await runFsTool("read_command_output", { cmd_id: 1 }, tmpDir);
      expect(result).toContain("line1");
      expect(result).toContain("line2");
      expect(result).toContain("line3");
    }, 15000);

    it("supports offset and limit pagination", async () => {
      await runFsTool("run_command", { command: "echo a && echo b && echo c && echo d" }, tmpDir);
      const result = await runFsTool("read_command_output", {
        cmd_id: 1, offset: 1, limit: 2, priority: "top",
      }, tmpDir);
      expect(result).toContain("b");
      expect(result).toContain("c");
    }, 15000);

    it("supports regex filter", async () => {
      await runFsTool("run_command", { command: "echo lineA100 && echo lineB200 && echo lineC300" }, tmpDir);
      const result = await runFsTool("read_command_output", {
        cmd_id: 1, filter: "lineA|lineB",
      }, tmpDir);
      // Filtered lines include lineA100 and lineB200
      expect(result).toMatch(/lineA100/);
      expect(result).toMatch(/lineB200/);
      // lineC300 should NOT be in the filtered output lines
      // (but the header always echoes the full command, so we verify the filter summary instead)
      expect(result).toContain("matched 2 lines");
    }, 15000);

    it("errors when cmd_id is missing or invalid", async () => {
      const result = await runFsTool("read_command_output", { cmd_id: "" }, tmpDir);
      expect(result).toContain("cmd_id is required");
    });

    it("errors when command is not found", async () => {
      const result = await runFsTool("read_command_output", { cmd_id: 99999 }, tmpDir);
      expect(result).toContain("not found");
    });
  });
});
