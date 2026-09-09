import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tention/report-schema": fileURLToPath(new URL("../report-schema/src/index.ts", import.meta.url)),
    },
  },
});
