import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Product code must serve every client through configuration. Client names,
 * IDs, and Klaviyo account labels may appear only in tests and in the developer
 * CLI harnesses below, which replay historical fixtures and never run in the
 * API server or the extension.
 */
const root = resolve(process.cwd(), "../..");
const DEVELOPER_CLI_HARNESSES = new Set([
  "apps/api/src/reports/dev-partial-review.ts",
  "apps/api/src/reports/extension-e2e.ts",
  "apps/api/src/reports/extension-e2e-contract.ts",
  "apps/api/src/reports/klaviyo-source-discovery.ts",
  "apps/api/src/reports/pdf-smoke.ts",
]);
const SOURCE_ROOTS = ["apps/extension/src", "apps/api/src", "packages/api-client/src", "packages/report-core/src", "packages/report-domain/src", "packages/report-schema/src"];
const CLIENT_SPECIFIC = /autoled|club[\s_-]?furniture|f577d631|701a35ea|01HWZSHD83RW7CYWQ6EVVQD2BK|01H2XYS7EKZT3VVQYBQ19GTVW1/i;

function productFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return productFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [relative(root, path)] : [];
  });
}

describe("no client-specific product logic", () => {
  it("keeps client names, IDs, and dashboard IDs out of every product source file", () => {
    const files = SOURCE_ROOTS.flatMap((directory) => productFiles(join(root, directory))).filter((file) => !DEVELOPER_CLI_HARNESSES.has(file));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => CLIENT_SPECIFIC.test(readFileSync(join(root, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("does not let the running API import a developer harness's client-specific entry points", () => {
    const runtime = readFileSync(join(root, "apps/api/src/reports/canonical-partial-review.ts"), "utf8");
    expect(runtime.match(/import \{([^}]*)\} from "\.\/dev-partial-review\.js"/)?.[1]?.trim()).toBe("renderPartialReviewHtml");
    for (const harness of DEVELOPER_CLI_HARNESSES) {
      const name = harness.split("/").pop()!.replace(/\.ts$/, ".js");
      const importers = SOURCE_ROOTS.flatMap((directory) => productFiles(join(root, directory)))
        .filter((file) => !DEVELOPER_CLI_HARNESSES.has(file) && file !== "apps/api/src/reports/canonical-partial-review.ts")
        .filter((file) => readFileSync(join(root, file), "utf8").includes(`/${name}"`));
      expect(importers, harness).toEqual([]);
    }
  });
});
