import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: {
    "@tention/api-client": fileURLToPath(new URL("../../packages/api-client/src/index.ts", import.meta.url)),
    "@tention/report-core": fileURLToPath(new URL("../../packages/report-core/src/index.ts", import.meta.url)),
    "@tention/report-schema": fileURLToPath(new URL("../../packages/report-schema/src/index.ts", import.meta.url)),
  } },
  test: { environment: "jsdom", environmentOptions: { jsdom: { url: "https://www.klaviyo.com/analytics/dashboards/test-dashboard" } }, setupFiles: ["./src/test/setup.ts"] },
});
