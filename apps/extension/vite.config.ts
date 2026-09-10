import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    "@tention/api-client": fileURLToPath(new URL("../../packages/api-client/src/index.ts", import.meta.url)),
    "@tention/report-core": fileURLToPath(new URL("../../packages/report-core/src/index.ts", import.meta.url)),
    "@tention/report-schema": fileURLToPath(new URL("../../packages/report-schema/src/index.ts", import.meta.url)),
  } },
  build: { outDir: "dist", emptyOutDir: true },
});
