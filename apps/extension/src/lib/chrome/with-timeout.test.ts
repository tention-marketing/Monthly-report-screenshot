import { describe, expect, it } from "vitest";
import { ChromeOperationTimeoutError, withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("rejects a stalled Chrome operation instead of waiting indefinitely", async () => {
    await expect(withTimeout(() => new Promise(() => undefined), "checking a tab", 1))
      .rejects.toBeInstanceOf(ChromeOperationTimeoutError);
  });
});
