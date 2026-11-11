import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFailure, KNOWN_FAILURES, recoveryPlan } from "./recovery-policy.js";

describe("shared recovery policy", () => {
  it.each([
    ["SCRIPT_RESULT_INVALID", "SCRIPT_RESULT_INVALID", false], ["SCRIPT_RESULT_UNDEFINED", "SCRIPT_RESULT_INVALID", false],
    ["CAPTURE_TIMEOUT", "STAGE_TIMEOUT", false], ["UPLOAD_TIMEOUT", "UPLOAD_FAILED", false], ["PERSISTENCE_TIMEOUT", "PERSISTENCE_FAILED", false],
    ["BUSINESS_REVIEW_CARD_NOT_FOUND", "CARD_NOT_READY", false], ["BUSINESS_REVIEW_TAB_NOT_SELECTED", "VIEW_NOT_SELECTED", false],
    ["COMPARISON_PERIOD_NOT_CONFIRMED", "PERIOD_NOT_CONFIRMED", false], ["TARGET_LAYOUT_NOT_STABLE", "LAYOUT_UNSTABLE", false],
    ["BUSINESS_REVIEW_TARGET_OCCLUDED", "TARGET_OBSCURED", false], ["TARGET_NOT_VISIBLE", "TARGET_BOUNDS_INVALID", false],
    ["GRANTED_TAB_NOT_ACTIVE", "TAB_NOT_ACTIVE", false],
    ["ACCOUNT_CONTEXT_MISMATCH", "WRONG_ACCOUNT", true], ["ACTION_NOT_INVOKED", "TOOLBAR_GRANT_LOST", true],
    ["CAMPAIGNS_ROUTE_REQUIRED", "LOGIN_REQUIRED", true], ["BUSINESS_REVIEW_URL_REQUIRED", "CONFIGURATION", true], ["SOURCE_PROOF_SCHEMA_INVALID", "SOURCE_PROOF_FAILED", true],
    ["KLAVIYO_VIEWPORT_TOO_NARROW", "LAYOUT_UNSTABLE", false], ["KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED", "CONFIGURATION", true],
  ] as const)("classifies %s as %s (permanent: %s)", (code, category, permanent) => {
    expect(classifyFailure(code)).toMatchObject({ category, permanent });
  });

  it("recognises the session-storage quota fingerprint behind a generic CAPTURE_FAILED", () => {
    expect(classifyFailure("CAPTURE_FAILED", "Session storage quota bytes exceeded. Values were not stored.")).toEqual({ category: "CAPTURE_STATE_STORAGE_FULL", permanent: false, knownFailure: "SESSION_STORAGE_QUOTA" });
  });

  it.each(["CAPTURE_FAILED", "SCRIPT_RESULT_INVALID", "BUSINESS_REVIEW_CARD_NOT_FOUND", "CAPTURE_TIMEOUT", "UPLOAD_TIMEOUT"])("never repeats an identical attempt after %s: every level strictly adds a recovery action", (code) => {
    let earlier = recoveryPlan(1, null).actions;
    expect(earlier).toEqual(["fresh-source"]);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const plan = recoveryPlan(attempt, { code }, earlier);
      expect(plan.level).toBe(attempt - 1);
      expect(plan.previousFailure).toBe(code);
      expect(plan.actions.length).toBeGreaterThan(earlier.length);
      expect(plan.actions).toEqual(expect.arrayContaining(earlier));
      earlier = plan.actions;
    }
    expect(new Set(earlier)).toEqual(new Set(["fresh-source", "settle-before-inject", "extended-readiness", "release-capture-state", "cool-down-before-retry", ...(code === "UPLOAD_TIMEOUT" ? ["retry-backend-write"] : [])]));
  });

  it("starts each category's recovery with its own remedy", () => {
    expect(recoveryPlan(2, { code: "CAPTURE_FAILED", message: "Session storage quota bytes exceeded." }).actions).toEqual(["fresh-source", "release-capture-state"]);
    expect(recoveryPlan(2, { code: "SCRIPT_RESULT_INVALID" }).actions).toEqual(["fresh-source", "settle-before-inject"]);
    expect(recoveryPlan(2, { code: "BUSINESS_REVIEW_CARD_NOT_FOUND" }).actions).toEqual(["fresh-source", "extended-readiness"]);
  });

  it("keeps every known failure tied to a regression test that exists", () => {
    const root = resolve(process.cwd(), "src");
    const files: string[] = [];
    const walk = (directory: string) => { for (const name of readdirSync(directory)) { const path = join(directory, name); if (statSync(path).isDirectory()) walk(path); else if (/\.test\.tsx?$/.test(name)) files.push(path); } };
    walk(root);
    const tests = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const known of KNOWN_FAILURES) {
      expect(tests.includes(known.regressionTest), `${known.id} → "${known.regressionTest}"`).toBe(true);
      expect(known.rootCause.length).toBeGreaterThan(20); expect(known.recovery.length).toBeGreaterThan(20);
    }
    const registry = readFileSync(resolve(process.cwd(), "../../docs/RELIABILITY_REGISTRY.md"), "utf8");
    for (const known of KNOWN_FAILURES) expect(registry, known.id).toContain(known.id);
  });
});
