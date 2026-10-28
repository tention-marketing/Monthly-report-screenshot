import { describe, expect, it } from "vitest";
import { resolveConfiguredPdfArtifactStorageDirectory } from "./configured-pdf-artifact-storage.js";
import { resolveConfiguredScreenshotStorageDirectory } from "./configured-storage.js";

describe("configured local artifact storage", () => {
  it("uses repository-stable defaults rather than the npm workspace cwd", () => {
    const repositoryRun = "/repo";
    const apiWorkspaceRun = "/repo/apps/api";
    expect(resolveConfiguredScreenshotStorageDirectory({}, repositoryRun)).toBe(resolveConfiguredScreenshotStorageDirectory({}, apiWorkspaceRun));
    expect(resolveConfiguredPdfArtifactStorageDirectory({}, repositoryRun)).toBe(resolveConfiguredPdfArtifactStorageDirectory({}, apiWorkspaceRun));
  });

  it("continues to resolve an explicit relative override from the service cwd", () => {
    expect(resolveConfiguredScreenshotStorageDirectory({ SCREENSHOT_STORAGE_DIR: "custom/screenshots" }, "/repo/apps/api")).toBe("/repo/apps/api/custom/screenshots");
    expect(resolveConfiguredPdfArtifactStorageDirectory({ REPORT_ARTIFACT_STORAGE_DIR: "custom/artifacts" }, "/repo/apps/api")).toBe("/repo/apps/api/custom/artifacts");
  });
});
