import type { Page } from "playwright";

export interface SemanticCardTarget {
  key: string;
  headings: readonly string[];
  tab?: string;
  requiredText?: readonly string[];
  minimumRows?: number;
}

export async function resolveSemanticCard(page: Page, target: SemanticCardTarget): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate((section) => {
    document.querySelector(`[data-tention-local-capture="${section.key}"]`)?.removeAttribute("data-tention-local-capture");
    const matchingHeading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find((node) => {
      const rect = node.getBoundingClientRect();
      const label = (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      return rect.width > 1 && rect.height > 1 && section.headings.some((heading) => label === heading.toLowerCase());
    });
    if (!matchingHeading) return { ok: false, error: "The semantic card heading was not found." };
    let candidate = matchingHeading.parentElement;
    while (candidate && candidate !== document.body && candidate !== document.documentElement && candidate.tagName !== "MAIN") {
      const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const hasRequiredText = Boolean(section.tab) || !section.requiredText || section.requiredText.every((value) => text.includes(value.toLowerCase()));
      const hasTab = !section.tab || [...candidate.querySelectorAll("[role=tab],button,[role=button],[aria-pressed],[aria-selected]")].some((node) => ((node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === section.tab!.toLowerCase()));
      const rect = candidate.getBoundingClientRect();
      if (hasRequiredText && hasTab && rect.width > 200 && rect.height > 80) { candidate.setAttribute("data-tention-local-capture", section.key); return { ok: true }; }
      candidate = candidate.parentElement;
    }
    return { ok: false, error: "No smallest semantic card ancestor contained the required card-local evidence." };
  }, target);
}

export async function waitForRequiredCardContent(page: Page, target: SemanticCardTarget): Promise<boolean> {
  return page.waitForFunction((section) => {
    const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === section.headings[0]?.toLowerCase());
    if (!heading) return false;
    let candidate = heading.parentElement;
    while (candidate && candidate !== document.body && candidate !== document.documentElement && candidate.tagName !== "MAIN") {
      const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const required = section.tab ? true : !section.requiredText || section.requiredText.every((value) => text.includes(value.toLowerCase()));
      const tab = !section.tab || [...candidate.querySelectorAll("[role=tab],button,[role=button],[aria-pressed],[aria-selected]")].some((node) => ((node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === section.tab!.toLowerCase()));
      if (required && tab && !candidate.querySelector('[data-testid*="spinner"],[data-asc="Spinner"]')) return true;
      candidate = candidate.parentElement;
    }
    return false;
  }, target, { timeout: 20_000 }).then(() => true).catch(() => false);
}

/** Rebinds the semantic crop marker after Klaviyo replaces a React card during a view/tab change. */
export async function reacquireSemanticCardAfterViewChange(page: Page, target: SemanticCardTarget): Promise<{ ok: boolean; error?: string }> {
  const rendered = await page.waitForFunction((section) => {
    const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === section.headings[0]?.toLowerCase());
    if (!heading) return false;
    let candidate = heading.parentElement;
    while (candidate && candidate !== document.body && candidate !== document.documentElement && candidate.tagName !== "MAIN") {
      const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const required = !section.requiredText || section.requiredText.every((value) => text.includes(value.toLowerCase()));
      const rows = [...candidate.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length;
      if (required && rows >= (section.minimumRows ?? 0) && !candidate.querySelector('[data-testid*="spinner"],[data-asc="Spinner"]')) return true;
      candidate = candidate.parentElement;
    }
    return false;
  }, target, { timeout: 20_000 }).then(() => true).catch(() => false);
  if (!rendered) return { ok: false, error: "The requested tab content did not settle with its required semantic text and rows after the view changed." };
  return resolveSemanticCard(page, target);
}

/** Scrolls a semantic card even when Klaviyo replaces its React subtree as the scroll begins. */
export async function scrollSemanticCardIntoView(page: Page, target: SemanticCardTarget): Promise<{ ok: boolean; error?: string }> {
  let lastError = "The semantic card could not be scrolled into capture position.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!await waitForRequiredCardContent(page, target)) {
      return { ok: false, error: "The semantic card lost its required content before scrolling into capture position." };
    }
    const resolved = await resolveSemanticCard(page, target);
    if (!resolved.ok) return resolved;
    try {
      await page.locator(`[data-tention-local-capture="${target.key}"]`).scrollIntoViewIfNeeded({ timeout: 5_000 });
      const rebound = await reacquireSemanticCardAfterViewChange(page, target);
      if (rebound.ok) return rebound;
      lastError = rebound.error ?? lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
    if (attempt === 0) await page.waitForTimeout(150);
  }
  return { ok: false, error: lastError };
}
