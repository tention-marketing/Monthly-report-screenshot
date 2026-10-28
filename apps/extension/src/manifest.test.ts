import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")) as {
  permissions: string[]; host_permissions: string[]; background?: { service_worker?: string; type?: string }; side_panel?: { default_path?: string }; action?: { default_popup?: string };
};

describe("extension permission scope", () => {
  it("uses only the permissions required for side-panel capture and persistent Executive Summary automation", () => {
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "sidePanel", "storage"]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
  });
  it("limits host permissions to the local API and Klaviyo", () => {
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1:4000/*", "https://www.klaviyo.com/*"]);
  });
  it("uses a module service worker and shared side-panel UI instead of a focus-closing action popup", () => {
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.side_panel).toEqual({ default_path: "index.html" });
    expect(manifest.action?.default_popup).toBeUndefined();
    expect(manifest.action).toEqual({ default_title: "Tention Reports" });
  });
});
