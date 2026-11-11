import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadLocalEnvironment, resolveServerPort } from "./server-config.js";

describe("API server port configuration", () => {
  it("uses port 4000 for local development when PORT is absent", () => {
    expect(resolveServerPort(undefined)).toBe(4000);
    expect(resolveServerPort("")).toBe(4000);
  });

  it("preserves a platform-provided PORT override", () => {
    expect(resolveServerPort("9876")).toBe(9876);
  });
  it("limits local development routes to loopback bind addresses", () => {
    expect(["localhost", "127.0.0.1", "127.0.0.2", "::1"].every(isLoopbackHost)).toBe(true);
    expect(["0.0.0.0", "192.168.1.2", "tention.local"].some(isLoopbackHost)).toBe(false);
  });
});

describe("local .env loading", () => {
  const envFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "api-env-"));
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgresql://user:pass@localhost:5434/tention_reports\nSCREENSHOT_STORAGE_DIR=./data/screenshots\nREPORT_ARTIFACT_STORAGE_DIR=/abs/artifacts\n");
    return { dir, file: join(dir, ".env") };
  };
  it("fills only unset variables, and resolves relative storage paths against the .env directory, not the cwd", () => {
    const { dir, file } = envFile();
    const environment: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://shell@db:5432/other" };
    expect(loadLocalEnvironment(file, environment)).toBe(true);
    expect(environment.DATABASE_URL).toBe("postgresql://shell@db:5432/other");
    expect(environment.SCREENSHOT_STORAGE_DIR).toBe(join(dir, "data/screenshots"));
    expect(environment.REPORT_ARTIFACT_STORAGE_DIR).toBe("/abs/artifacts");
  });
  it("loads the database URL when it is not already set, and never loads in production or without a file", () => {
    const { dir, file } = envFile();
    const environment: NodeJS.ProcessEnv = {};
    loadLocalEnvironment(file, environment);
    expect(new URL(environment.DATABASE_URL!).port).toBe("5434");
    const production: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    expect(loadLocalEnvironment(file, production)).toBe(false);
    expect(production.DATABASE_URL).toBeUndefined();
    expect(loadLocalEnvironment(join(dir, "missing.env"), {})).toBe(false);
  });
});
