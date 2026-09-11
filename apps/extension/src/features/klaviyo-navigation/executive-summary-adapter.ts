export type KlaviyoAutomationFailureCode =
  | "KLAVIYO_PAGE_NOT_SUPPORTED"
  | "TARGET_NOT_FOUND"
  | "PERIOD_NOT_FOUND"
  | "PERIOD_SET_FAILED"
  | "PERIOD_VERIFY_FAILED"
  | "TARGET_NOT_FULLY_VISIBLE"
  | "CAPTURE_FAILED";

export interface ExecutiveSummaryTargetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export type ExecutiveSummaryAdapterResult =
  | { kind: "ready"; detectedPeriod: string; target: ExecutiveSummaryTargetBounds }
  | { kind: "failed"; code: Exclude<KlaviyoAutomationFailureCode, "CAPTURE_FAILED"> };

/**
 * This function intentionally uses only semantic browser signals so it can run both
 * in a Klaviyo tab through chrome.scripting and in DOM-level tests. Keep all DOM
 * interaction here; React only receives a typed preparation result.
 */
export async function prepareExecutiveSummaryDocument(expectedPeriod: string): Promise<ExecutiveSummaryAdapterResult> {
  const normalized = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const visibleText = (element: Element) => (element as HTMLElement).innerText || element.textContent || "";
  const semanticName = (element: Element) => {
    const html = element as HTMLInputElement;
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelText = labelledBy
      ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
      : "";
    return [element.getAttribute("aria-label"), labelText, html.value, visibleText(element)].filter(Boolean).join(" ");
  };
  const expectedVariants = (() => {
    const longMonth = expectedPeriod.replace(/\bJan\b/g, "January").replace(/\bFeb\b/g, "February").replace(/\bMar\b/g, "March")
      .replace(/\bApr\b/g, "April").replace(/\bJun\b/g, "June").replace(/\bJul\b/g, "July").replace(/\bAug\b/g, "August")
      .replace(/\bSep\b/g, "September").replace(/\bOct\b/g, "October").replace(/\bNov\b/g, "November").replace(/\bDec\b/g, "December");
    return [expectedPeriod, expectedPeriod.replace("–", "-"), longMonth, longMonth.replace("–", "-")];
  })();
  const matchesExpectedPeriod = (value: string) => expectedVariants.some((variant) => normalized(value).includes(normalized(variant)));
  const interactive = () => Array.from(document.querySelectorAll("button, input, select, [role=button], [role=combobox], [role=option], [role=menuitem]"));
  const periodControls = () => interactive().filter((element) => /time period|date range|reporting period/i.test(semanticName(element)));
  const detectedPeriod = () => periodControls().find((element) => matchesExpectedPeriod(semanticName(element))) ? expectedPeriod : null;

  const headings = () => Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"));
  const businessReviewHeading = headings().find((element) => normalized(visibleText(element)) === "business review");
  const currentBusinessReview = document.querySelector('[aria-current="page"]');
  if (!businessReviewHeading && (!currentBusinessReview || normalized(semanticName(currentBusinessReview)).includes("business review") === false)) {
    return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" };
  }

  if (!detectedPeriod()) {
    const control = periodControls()[0];
    if (!control) return { kind: "failed", code: "PERIOD_NOT_FOUND" };
    (control as HTMLElement).click();
    await nextFrame();
    const exactOption = interactive().find((element) => element !== control && matchesExpectedPeriod(semanticName(element)));
    if (!exactOption) return { kind: "failed", code: "PERIOD_SET_FAILED" };
    (exactOption as HTMLElement).click();
    await nextFrame();
    if (!detectedPeriod()) return { kind: "failed", code: "PERIOD_VERIFY_FAILED" };
  }

  const heading = headings().find((element) => normalized(visibleText(element)) === "growth overview");
  if (!heading) return { kind: "failed", code: "TARGET_NOT_FOUND" };
  const target = heading.closest("article, section, [role=region], [role=group]") ?? heading.parentElement ?? heading;
  target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  await nextFrame();
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { kind: "failed", code: "TARGET_NOT_FOUND" };
  if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
    return { kind: "failed", code: "TARGET_NOT_FULLY_VISIBLE" };
  }
  return {
    kind: "ready",
    detectedPeriod: expectedPeriod,
    target: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
  };

  async function nextFrame(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else resolve();
    });
  }
}
