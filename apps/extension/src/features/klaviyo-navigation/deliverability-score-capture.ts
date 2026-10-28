import type { ScreenshotType } from "@tention/report-schema";

export interface DeliverabilityScoreTargetBounds {
  x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number;
  visibleControls: Array<Record<string, string | boolean | null>>;
}
export type DeliverabilityScoreAdapterResult =
  | { ok: true; sourceUrl: string; targetRect: DeliverabilityScoreTargetBounds; diagnostics: { observedScoreText: string | null; stableSamples: number } }
  | { ok: false; code: "DELIVERABILITY_SCORE_NOT_FOUND" | "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED" | "DELIVERABILITY_SCORE_NOT_STABLE" | "TARGET_BOUNDS_INVALID" | "KLAVIYO_PAGE_ADAPTER_ERROR"; message: string; diagnostics?: Record<string, unknown> };

export interface DeliverabilityScoreStabilityOptions { sampleIntervalMs: number; requiredStableSamples: number; timeoutMs: number }

/**
 * Serialized into the toolbar-authorized tab. It only reads, scrolls, and marks a
 * screenshot crop; it never clicks Create segment, Start cleaning, or Mark done.
 *
 * Klaviyo animates the score gauge by counting the number up after the card first
 * renders, so the card is accepted only after its text and gauge geometry stay
 * identical across consecutive samples. Must stay self-contained: Chrome
 * serializes this function and runs it without module scope.
 */
export async function prepareDeliverabilityScoreDocument(options: DeliverabilityScoreStabilityOptions = { sampleIntervalMs: 250, requiredStableSamples: 4, timeoutMs: 8_000 }): Promise<DeliverabilityScoreAdapterResult> {
  // Chrome reports an exception that escapes an injected function as a bare `null` result (run 8fdc5fcc), and a
  // DOM object or cycle in the result cannot cross back to the extension. Every exit is therefore plain JSON, and
  // any exception — including one raised while building failure diagnostics — becomes a typed, serializable failure.
  try {
    const result = await (async (): Promise<DeliverabilityScoreAdapterResult> => {
      const safeUrl = `${location.origin}${location.pathname}`;
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const metricLabels = ["open rate", "click rate", "bounce rate", "unsubscribe rate", "spam complaint rate"];
      const rollingWindow = /based on (the )?last 30 days/;
      const visible = (node: Element) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 80 && rect.height > 60; };
      const main = document.querySelector("#app-shell-main") ?? document.querySelector("main");
      const failure = (code: "DELIVERABILITY_SCORE_NOT_FOUND" | "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED" | "DELIVERABILITY_SCORE_NOT_STABLE" | "TARGET_BOUNDS_INVALID", message: string, extra: Record<string, unknown> = {}): DeliverabilityScoreAdapterResult => ({ ok: false, code, message, diagnostics: { currentUrl: safeUrl, requiredText: ["deliverability score", "based on last 30 days", "your score is", "three or more rate labels"], visibleText: normalize(main?.textContent).slice(0, 4000), ...extra } });
      const isScoreCard = (text: string) => text.includes("deliverability score") && rollingWindow.test(text) && text.includes("your score is")
        && metricLabels.filter((label) => text.includes(label)).length >= 3 && !text.includes("action center");
      const findCard = (): HTMLElement | undefined => {
        if (!main) return undefined;
        return [...main.querySelectorAll<HTMLElement>("article,section,[role=region],div")]
          .filter(visible).map((node) => ({ node, text: normalize(node.innerText || node.textContent), rect: node.getBoundingClientRect() }))
          .filter(({ text }) => isScoreCard(text))
          .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height))[0]?.node;
      };
      // Text plus SVG gauge geometry: a JS count-up changes the number, an arc tween changes path/dash attributes.
      const signature = (card: HTMLElement) => {
        const rect = card.getBoundingClientRect();
        const gauge = [...card.querySelectorAll("svg path, svg circle")].map((node) => ["d", "stroke-dashoffset", "stroke-dasharray", "transform", "style"].map((name) => node.getAttribute(name) ?? "").join("|")).join(";");
        return `${normalize(card.innerText || card.textContent)}#${gauge}#${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
      };
      const animating = (card: HTMLElement) => typeof document.getAnimations === "function"
        && document.getAnimations().some((animation) => { const target = (animation.effect as KeyframeEffect | null)?.target; return animation.playState === "running" && target instanceof Node && card.contains(target); });
      const scoreText = (card: HTMLElement) => normalize(card.innerText || card.textContent).match(/(\d{1,3})\s*your score is/)?.[1] ?? null;
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      if (!/^\/analytics\/deliverability\/email\/score\/?$/i.test(location.pathname)) return failure("DELIVERABILITY_SCORE_NOT_FOUND", "The authorized Klaviyo tab is not the standalone Email Deliverability Score route.");
      if (!main) return failure("DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED", "The standalone Deliverability page has not rendered its main region.");
      if (!findCard()) return failure("DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED", "The Deliverability Email Score view has not rendered its score and sufficient rate evidence in the main page region.");

      const deadline = Date.now() + options.timeoutMs;
      let previous: string | null = null; let stableSamples = 0; let card: HTMLElement | undefined;
      while (Date.now() <= deadline) {
        card = findCard();
        if (!card) return failure("DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED", "The Deliverability Score card was replaced without a semantic match.");
        card.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
        const current = signature(card);
        stableSamples = current === previous && !animating(card) ? stableSamples + 1 : 0;
        previous = current;
        if (stableSamples >= options.requiredStableSamples) break;
        await sleep(options.sampleIntervalMs);
      }
      if (!card || stableSamples < options.requiredStableSamples) return failure("DELIVERABILITY_SCORE_NOT_STABLE", "The Deliverability Score gauge did not settle; Klaviyo may still be animating or reloading the card.", { stableSamples });
      const rect = card.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 120) return failure("TARGET_BOUNDS_INVALID", "No clean Deliverability Score card bounds were available outside Action Center.");
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return failure("TARGET_BOUNDS_INVALID", "The Deliverability Score card does not fit fully inside the visible tab; enlarge the browser window so the score and every rate row are visible.", { cardHeight: Math.round(rect.height), viewportHeight: window.innerHeight });
      card.dataset.tentionDeliverabilityScore = "capture";
      return { ok: true, sourceUrl: safeUrl, targetRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, visibleControls: [] }, diagnostics: { observedScoreText: scoreText(card), stableSamples } };
    })();
    return JSON.parse(JSON.stringify(result)) as DeliverabilityScoreAdapterResult;
  } catch (error) {
    return { ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: `The Klaviyo page helper failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), diagnostics: { failureStage: "UNCAUGHT_EXCEPTION", errorName: error instanceof Error ? error.name : typeof error, stack: (error instanceof Error && error.stack ? error.stack : "").split("\n").slice(0, 8).join("\n").slice(0, 2_000), currentUrl: `${location.origin}${location.pathname}` } };
  }
}

export function isDeliverabilityScoreScreenshotType(value: ScreenshotType): value is "deliverability" { return value === "deliverability"; }
