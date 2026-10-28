import { describe, expect, it } from "vitest";
import { accountLabelMatchesClient, verifyAccountIdentity } from "./klaviyo-account-identity.js";

describe("Klaviyo account identity", () => {
  it("matches the visible account label with or without avatar initials and .com suffix", () => {
    expect(accountLabelMatchesClient("CL Club Furniture", "Club Furniture")).toBe(true);
    expect(accountLabelMatchesClient("Club Furniture", "Club Furniture")).toBe(true);
    expect(accountLabelMatchesClient("AU AutoLEDTech", "AutoLEDTech.com")).toBe(true);
    expect(accountLabelMatchesClient("AutoLEDTech.com", "AutoLEDTech.com")).toBe(true);
  });
  it("rejects another client's account", () => {
    expect(accountLabelMatchesClient("CL Club Furniture", "AutoLEDTech.com")).toBe(false);
    expect(verifyAccountIdentity(["Home", "CL Club Furniture"], "AutoLEDTech.com")).toEqual({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", observedLabels: ["Home", "CL Club Furniture"] });
  });
  it("fails closed when no account label is visible", () => {
    expect(verifyAccountIdentity([], "Club Furniture")).toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_NOT_VERIFIED" });
  });
  it("finds the account switcher after many navigation labels", () => {
    const navigation = Array.from({ length: 60 }, (_, index) => `Nav item ${index}`);
    expect(verifyAccountIdentity([...navigation, "CL Club Furniture"], "Club Furniture")).toEqual({ ok: true, matchedLabel: "CL Club Furniture" });
  });
  it("accepts the configured account among unrelated navigation labels", () => {
    expect(verifyAccountIdentity(["Campaigns", "Flows", "CL Club Furniture"], "Club Furniture")).toEqual({ ok: true, matchedLabel: "CL Club Furniture" });
  });
});
