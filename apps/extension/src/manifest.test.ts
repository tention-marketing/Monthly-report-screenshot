import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")) as {
  permissions: string[]; host_permissions: string[];
};

describe("extension permission scope", () => {
  it("uses only the permissions required for user-initiated capture and the Executive Summary adapter", () => {
    expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
  });
  it("limits host permissions to the local API and Klaviyo", () => {
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1:3000/*", "https://www.klaviyo.com/*"]);
  });
});
