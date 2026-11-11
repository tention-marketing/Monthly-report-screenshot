import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Lets every live diagnostic run record exactly which extension build produced it; the local API
// compares it with dist/build.json so a run from a stale, un-reloaded extension is refused.
const BUILD = new Date().toISOString();

export default defineConfig({
  plugins: [react(), { name: "tention-build-stamp", generateBundle() { this.emitFile({ type: "asset", fileName: "build.json", source: `${JSON.stringify({ build: BUILD })}\n` }); } }],
  define: { __TENTION_BUILD__: JSON.stringify(BUILD) },
  resolve: { alias: {
    "@tention/api-client": fileURLToPath(new URL("../../packages/api-client/src/index.ts", import.meta.url)),
    "@tention/report-core": fileURLToPath(new URL("../../packages/report-core/src/index.ts", import.meta.url)),
    "@tention/report-schema": fileURLToPath(new URL("../../packages/report-schema/src/index.ts", import.meta.url)),
  } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        background: fileURLToPath(new URL("./src/background.ts", import.meta.url)),
        // Shared page helper loaded with chrome.scripting.executeScript({ files }) before period-setting adapters.
        "period-entry": fileURLToPath(new URL("./src/features/klaviyo-navigation/injected/period-entry.ts", import.meta.url)),
      },
      output: { entryFileNames: (chunk) => chunk.name === "background" ? "background.js" : chunk.name === "period-entry" ? "injected/period-entry.js" : "assets/[name]-[hash].js" },
    },
  },
});
