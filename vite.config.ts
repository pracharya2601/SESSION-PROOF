import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// UI-only build. The Worker serves dist/client as static assets.
export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: { proxy: { "^/api/": "http://localhost:8787", "^/auth/": "http://localhost:8787" } },
});
