import { describe, expect, it } from "vitest";
import { isLoopbackHost, resolveServerPort } from "./server-config.js";

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
