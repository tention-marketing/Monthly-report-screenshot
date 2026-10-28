import { describe, expect, it } from "vitest";
import { classifySourceDiscovery } from "./source-discovery-status.js";

describe("read-only report source discovery", () => {
  it("distinguishes a visible account-level forms table with no rows from a usable capture", () => {
    expect(classifySourceDiscovery({ source: "signup_forms", mainText: "Sign-up forms", tableHeaders: ["Name", "Type", "Status", "Submitted", "Submit rate", "Total revenue"], rowCount: 0 })).toMatchObject({ status: "SOURCE_VISIBLE_NO_ROWS" });
    expect(classifySourceDiscovery({ source: "signup_forms", mainText: "Sign-up forms", tableHeaders: ["Name", "Type", "Status", "Submitted", "Submit rate", "Total revenue"], rowCount: 2 })).toMatchObject({ status: "INSPECTED" });
  });

  it.each(["welcome_flow", "customer_split"] as const)("fails closed when the %s listing has no rows", (source) => {
    expect(classifySourceDiscovery({ source, mainText: "No data available", tableHeaders: [], rowCount: 0 })).toMatchObject({ status: "SOURCE_NOT_VISIBLE" });
  });

  it("preserves an explicit authentication blocker", () => {
    expect(classifySourceDiscovery({ source: "welcome_flow", authenticationRequired: true, mainText: "Sign in", tableHeaders: [], rowCount: 0 })).toMatchObject({ status: "AUTH_REQUIRED" });
  });
});
