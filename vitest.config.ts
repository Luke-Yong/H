import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/**/*.test.ts"],
    exclude: ["client/**", "node_modules/**", "electron/**"],
    testTimeout: 30000,
    env: { NODE_ENV: "test" },
  },
});
