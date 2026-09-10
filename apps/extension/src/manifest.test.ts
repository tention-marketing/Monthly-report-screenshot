import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")) as {
  permissions: string[]; host_permissions: string[];
};

describe("extension permission scope", () => {
  it("does not request all-URLs access or unneeded script execution", () => {
    expect(manifest.permissions).toEqual(["activeTab"]);
    expect(manifest.permissions).not.toContain("scripting");
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
  });
  it("limits host permission to the local development API", () => {
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1:3000/*"]);
  });
});
