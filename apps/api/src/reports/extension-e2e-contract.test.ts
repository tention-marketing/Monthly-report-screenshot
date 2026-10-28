import { describe, expect, it } from "vitest";
import { EXTENSION_E2E_TARGETS, findCanonicalE2eDrafts, findRecentReportCardsForIdentity, selectExtensionE2eTarget, type ExtensionE2eDraftIdentity } from "./extension-e2e-contract.js";

const canonical: ExtensionE2eDraftIdentity = {
  id: "f577d631-a1f6-4cc0-9052-68e30460876d",
  client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York" },
  reportMonth: { year: 2026, month: 8 },
};
const expected = { id: canonical.id, clientId: "autoledtech", year: 2026, month: 8 };

describe("extension E2E canonical report gate", () => {
  it("accepts only the exact canonical report identity", () => {
    expect(findCanonicalE2eDrafts([canonical], expected)).toEqual([canonical]);
    expect(findCanonicalE2eDrafts([], expected)).toEqual([]);
    expect(findCanonicalE2eDrafts([{ ...canonical, id: "another-id" }], expected)).toEqual([]);
    expect(findCanonicalE2eDrafts([{ ...canonical, reportMonth: { year: 2026, month: 7 } }], expected)).toEqual([]);
  });

  it("preserves duplicate matches so callers fail rather than silently choosing one", () => {
    expect(findCanonicalE2eDrafts([canonical, canonical], expected)).toHaveLength(2);
  });

  it("allows other clients in Recent Reports but rejects duplicate cards for the selected client and month", () => {
    const cards = ["Club Furniture August 2026 · Draft", "AutoLEDTech.com August 2026 · Draft", "AutoLEDTech.com July 2026 · Draft"];
    expect(findRecentReportCardsForIdentity(cards, { clientName: "AutoLEDTech.com", monthLabel: "August 2026" })).toEqual(["AutoLEDTech.com August 2026 · Draft"]);
    expect(findRecentReportCardsForIdentity([...cards, "AutoLEDTech.com August 2026 · Draft (legacy)"], { clientName: "AutoLEDTech.com", monthLabel: "August 2026" })).toHaveLength(2);
  });

  it("defaults to AutoLEDTech and selects another client only by explicit argument or env", () => {
    expect(selectExtensionE2eTarget([])).toBe(EXTENSION_E2E_TARGETS.autoledtech);
    expect(selectExtensionE2eTarget(["--client", "club-furniture"])).toMatchObject({ clientId: "club-furniture", clientName: "Club Furniture", reportId: "701a35ea-461a-40d8-8cdf-76c59a40e0a0" });
    expect(selectExtensionE2eTarget([], { TENTION_E2E_CLIENT: "club-furniture" }).clientId).toBe("club-furniture");
    expect(() => selectExtensionE2eTarget(["--client", "unknown"])).toThrow(/Unknown extension E2E client/);
  });

  it("keeps every target identity distinct", () => {
    const targets = Object.values(EXTENSION_E2E_TARGETS);
    expect(new Set(targets.map(({ reportId }) => reportId)).size).toBe(targets.length);
    expect(new Set(targets.map(({ clientId }) => clientId)).size).toBe(targets.length);
  });
});
