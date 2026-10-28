import { describe, expect, it } from "vitest";
import { extensionE2eIgnoreDefaultArgs, extensionE2eLaunchArgs } from "./extension-e2e-browser.js";

describe("real extension E2E browser launch", () => {
  it("keeps Playwright's default extension-disabling switch out and loads only the built extension", () => {
    const directory = "/isolated/apps/extension/dist";
    const args = extensionE2eLaunchArgs(directory);
    expect(extensionE2eIgnoreDefaultArgs).toContain("--disable-extensions");
    expect(args).toContain(`--disable-extensions-except=${directory}`);
    expect(args).toContain(`--load-extension=${directory}`);
    expect(args).not.toContain("--disable-extensions");
  });
});
