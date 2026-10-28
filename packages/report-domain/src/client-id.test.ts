import { describe, expect, it } from "vitest";
import { deriveClientId } from "./client-id.js";

describe("deriveClientId", () => {
  it("makes a stable safe id without exposing an editable client-id field", () => {
    expect(deriveClientId(" AutoLEDTech.com ")).toBe("autoledtech");
    expect(deriveClientId("Café & Co.")).toBe("cafe-co");
  });
  it("rejects names that cannot form a safe identifier", () => {
    expect(() => deriveClientId("---")).toThrow("Client name must contain");
  });
});
