// Vitest config for the AI eval suite (fake mode; no network, no key).
// Run: npx vitest run -c evals/vitest.config.ts   (root vitest.config.ts does not include evals/)
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("../scripts/platform/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["evals/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
  },
});
