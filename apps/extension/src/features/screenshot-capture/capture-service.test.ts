import { describe, expect, it } from "vitest";
import { isKlaviyoUrl } from "./capture-service.js";

describe("Klaviyo source-tab recognition", () => {
  it.each(["https://www.klaviyo.com/analytics", "https://app.klaviyo.com/dashboard"])("recognizes %s", (url) => expect(isKlaviyoUrl(url)).toBe(true));
  it.each(["https://klaviyo.example.com/", "https://example.com/?next=klaviyo.com", null])("does not recognize %s", (url) => expect(isKlaviyoUrl(url)).toBe(false));
});
