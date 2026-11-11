import { describe, expect, it } from "vitest";
import { accountIdentityKey, klaviyoAccountEvidence } from "./account-evidence.js";

const steven = { name: "Steven Dann", accountLabel: "ST Steven Dann" };
const others = [{ name: "Club Furniture", accountLabel: "CL Club Furniture" }, { name: "AutoLEDTech.com", accountLabel: null }];

describe("Klaviyo account evidence", () => {
  it("normalizes harmless presentation differences: avatar prefix, 'Account:' and case", () => {
    expect(accountIdentityKey("ST Steven Dann")).toBe("stevendann");
    expect(accountIdentityKey("Steven Dann")).toBe("stevendann");
    expect(accountIdentityKey("Account: ST Steven Dann")).toBe("stevendann");
    // A real lowercase word is not stripped as a prefix.
    expect(accountIdentityKey("The Dann Shop")).toBe("thedannshop");
  });

  it.each([["Steven Dann"], ["ST Steven Dann"], ["Account: Steven Dann"], ["steven dann"]])("accepts the bound account shown as %j", (label) => {
    expect(klaviyoAccountEvidence(["Dashboards", "ST", label], steven, others)).toBe("THIS_CLIENT");
  });

  it("blocks a page that shows another saved client's account", () => {
    expect(klaviyoAccountEvidence(["CL Club Furniture"], steven, others)).toBe("WRONG_ACCOUNT");
    expect(klaviyoAccountEvidence(["Club Furniture", "Help"], steven, others)).toBe("WRONG_ACCOUNT");
    expect(klaviyoAccountEvidence(["AutoLEDTech.com"], steven, others)).toBe("WRONG_ACCOUNT");
  });

  it("never treats a page without a recognizable account as a match", () => {
    expect(klaviyoAccountEvidence([], steven, others)).toBe("UNKNOWN");
    expect(klaviyoAccountEvidence(["ST", "Analytics", "Metrics"], steven, others)).toBe("UNKNOWN");
    expect(klaviyoAccountEvidence(["Stephanie Dann"], steven, others)).toBe("UNKNOWN");
  });

  it("a client whose name contains another client's name is still recognized as itself", () => {
    expect(klaviyoAccountEvidence(["Club Furniture Outlet"], { name: "Club Furniture Outlet" }, others)).toBe("THIS_CLIENT");
  });
});
