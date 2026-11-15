import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `cloudflare:workers` only exists inside workerd. Tests run in node, so any
    // module that imports WorkflowEntrypoint etc. resolves to a minimal stub.
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./scripts/platform/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "fixtures/**/*.test.ts", "evals/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    passWithNoTests: true,
  },
});
