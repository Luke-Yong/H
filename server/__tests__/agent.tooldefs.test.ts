// ── Tool definition validation tests ──
// Validates TOOLS array: schema correctness, no duplicates, required fields.

import { describe, it, expect } from "vitest";
import { TOOLS } from "../agent";

describe("Tool definitions - Schema validation", () => {
  it("has at least the expected number of tools", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(20);
  });

  it("every tool has name, description, and parameters", () => {
    for (const tool of TOOLS) {
      expect(tool.name, `Tool missing name`).toBeTruthy();
      expect(tool.name.length, `${tool.name}: name too short`).toBeGreaterThan(0);
      expect(tool.description, `${tool.name}: missing description`).toBeTruthy();
      expect(tool.description.length, `${tool.name}: description too short (< 10 chars)`).toBeGreaterThan(10);
      expect(tool.parameters, `${tool.name}: missing parameters`).toBeDefined();
      expect(tool.parameters.type, `${tool.name}: parameters.type must be 'object'`).toBe("object");
    }
  });

  it("has no duplicate tool names", () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all required params exist in properties", () => {
    for (const tool of TOOLS) {
      if (tool.parameters.required && Array.isArray(tool.parameters.required)) {
        for (const key of tool.parameters.required) {
          expect(
            tool.parameters.properties,
            `${tool.name}: required param "${key}" missing from properties`,
          ).toHaveProperty(key);
        }
      }
    }
  });

  it("all properties have type and description", () => {
    for (const tool of TOOLS) {
      if (tool.parameters.properties) {
        for (const [key, prop] of Object.entries(tool.parameters.properties as Record<string, any>)) {
          expect(prop.type ?? prop.enum, `${tool.name}.${key}: missing type or enum`).toBeTruthy();
          expect(prop.description, `${tool.name}.${key}: missing description`).toBeTruthy();
        }
      }
    }
  });

  it("covers all expected tool categories", () => {
    const names = TOOLS.map(t => t.name);

    // Filesystem tools
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("list_files");
    expect(names).toContain("search_files");
    expect(names).toContain("grep");
    expect(names).toContain("create_directory");
    expect(names).toContain("delete_file");
    expect(names).toContain("rename_file");

    // Terminal tools
    expect(names).toContain("run_command");
    expect(names).toContain("run_in_terminal");

    // Browser tools
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_console");
    expect(names).toContain("browser_request_errors");
    expect(names).toContain("browser_info");
    expect(names).toContain("browser_get_dialog");
    expect(names).toContain("browser_respond_dialog");

    // Diagnostics
    expect(names).toContain("read_problems");
    expect(names).toContain("read_command_output");

    // Control
    expect(names).toContain("write_todos");
    expect(names).toContain("write_summary");
    expect(names).toContain("task_complete");
  });
});
