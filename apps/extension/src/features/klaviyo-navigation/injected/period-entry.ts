/**
 * Shared Klaviyo date-range entry, injected once into the page (chrome.scripting files) before every page adapter that
 * sets a reporting period. Adapters are serialized one function at a time and cannot import helpers, so this file is
 * self-contained (no imports, no exports) and installs `globalThis.__tentionPeriodEntry` in the extension's isolated
 * world, where the adapter injected next finds it.
 *
 * The report period is the single source of truth: whatever range Klaviyo kept from an earlier report, client, tab or
 * session is replaced with the report's exact dates. A field only counts as set when its own displayed value parses to
 * the expected date; the caller must never click Apply otherwise.
 */
(() => {
  type Fields = { start: HTMLInputElement; end: HTMLInputElement };
  type Strategy = "calendar" | "set-value" | "insert-text" | "type-keys";
  interface EntryAttempt { strategy: Strategy; order: "start-first" | "end-first"; entered: [string, string]; observed: [string, string]; matched: boolean; afterReselect: boolean }
  interface EntryRequest {
    /** Re-queried after every step: Klaviyo may replace its inputs on each render. */
    fields: () => Fields | null;
    startDate: string; endDate: string;
    /** The adapter's formatter for a field; defaults to matching the field's own displayed format. */
    format?: (input: HTMLInputElement, iso: string) => string;
    /** Re-chooses the picker's Custom preset, which re-creates fresh date fields; tried once if no strategy sticks. */
    reselectCustom?: () => Promise<boolean>;
  }
  interface CalendarDetail { openedBy: string | null; calendarMonthBefore: string[]; navigation: string[]; datesClicked: Array<{ iso: string; via: string; label: string }>; rangeAfterSelection: [string, string] | null; failure: string | null }
  interface EntryResult { ok: boolean; strategy: Strategy | null; attempts: EntryAttempt[]; pickerValuesEntered: [string, string] | null; observed: [string, string] | null; reason: string | null; pickerStructure: Record<string, unknown> | null; calendar: CalendarDetail | null }

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  /** "Apr 01, 2026", "Apr 1, 2026", "April 1, 2026", "04/01/2026", "2026-04-01" → "2026-04-01"; anything else → null. */
  const parseDisplayedDate = (raw: string | null | undefined): string | null => {
    const value = (raw ?? "").trim().replace(/\s+/g, " ");
    let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) return `${match[3]}-${pad(Number(match[1]))}-${pad(Number(match[2]))}`;
    match = value.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
    if (match) { const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase()); if (month >= 0) return `${match[3]}-${pad(month + 1)}-${pad(Number(match[2]))}`; }
    return null;
  };
  /** Writes `iso` in the format the field (or its sibling fields) already shows. */
  const formatLike = (input: HTMLInputElement, iso: string, context: readonly string[] = []): string => {
    const [year, month, day] = iso.split("-") as [string, string, string];
    if (input.type === "date") return iso;
    const samples = [input.value, ...context].filter((value) => /\d{4}/.test(value));
    if (samples.some((value) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim()))) return iso;
    if (/\d{1,2}\/\d{1,2}\/\d{4}|mm\/dd/i.test(`${samples.join(" ")} ${input.placeholder}`)) return `${month}/${day}/${year}`;
    const short = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
    const padded = !samples.some((value) => /\b[a-z]{3}\.? \d, \d{4}/i.test(value)) && samples.some((value) => /\b[a-z]{3}\.? \d{2}, \d{4}/i.test(value));
    return padded ? short.replace(/ (\d),/, " 0$1,") : short;
  };

  const settle = () => new Promise<void>((resolve) => {
    // A hidden tab runs no animation frames; never wait on one alone.
    const done = () => window.setTimeout(resolve, 60);
    const fallback = window.setTimeout(done, 120);
    requestAnimationFrame(() => { window.clearTimeout(fallback); done(); });
  });
  const nativeSet = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const selectAll = (input: HTMLInputElement) => { input.focus(); try { input.setSelectionRange(0, input.value.length); } catch { input.select?.(); } };
  /** Browser editing commands produce the same beforeinput/input events as real typing; false when unsupported. */
  const editing = (command: "insertText" | "delete", value?: string) => { try { return document.execCommand(command, false, value); } catch { return false; } };
  const write = (input: HTMLInputElement, value: string, strategy: Strategy): boolean => {
    if (strategy === "set-value") { input.focus(); nativeSet(input, value); return true; }
    selectAll(input);
    if (strategy === "insert-text") return editing("insertText", value);
    if (!editing("delete") && input.value) nativeSet(input, "");
    for (const character of value) if (!editing("insertText", character)) return false;
    return true;
  };
  // ---------- Calendar interaction: what a person does in the picker, chosen by exact dates, never by coordinates ----------
  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  /** A date written out in an accessible label: "Wednesday, April 1, 2026", "Choose April 1st, 2026", "1 April 2026". */
  const parseLabelDate = (raw: string | null | undefined): string | null => {
    const value = (raw ?? "").replace(/\s+/g, " ");
    const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const names = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    let match = value.match(new RegExp(`\\b${names}\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, "i"));
    if (match) return `${match[3]}-${pad(MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1)}-${pad(Number(match[2]))}`;
    match = value.match(new RegExp(`\\b(\\d{1,2}) ${names}\\.? (\\d{4})\\b`, "i"));
    if (match) return `${match[3]}-${pad(MONTHS.indexOf(match[2]!.slice(0, 3).toLowerCase()) + 1)}-${pad(Number(match[1]))}`;
    return null;
  };
  const visibleNow = (element: Element): boolean => {
    const checker = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
    if (typeof checker === "function") return checker.call(element, { visibilityProperty: true, opacityProperty: false });
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node); if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const labelOf = (element: Element) => [element.getAttribute("aria-label"), element.getAttribute("title"), (element.textContent ?? "").trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 120);
  const ownText = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
  /** Month headings painted as one text node ("April 2026"); text-node scan keeps this linear on large pages. */
  const rawCaptions = () => {
    const found: Array<{ element: Element; index: number; text: string }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      let element = node.parentElement;
      // A heading painted in pieces ("April" + "2026"): its nearest ancestor reads "April 2026".
      if (MONTH_NAMES.includes(text.toLowerCase())) for (let up = element?.parentElement ?? null, depth = 0; up && depth < 2; up = up.parentElement, depth += 1) {
        const whole = ownText(up); if (/^[A-Za-z]+ \d{4}$/.test(whole)) { text = whole; element = up; break; } if (whole.length > 40) break;
      }
      const match = text.match(/^([A-Za-z]+) (\d{4})$/);
      const month = match ? MONTH_NAMES.indexOf(match[1]!.toLowerCase()) : -1;
      if (found.some((entry) => entry.element === element)) continue;
      if (month < 0 || !element || element.closest("input,select,option,textarea") || !visibleNow(element)) continue;
      found.push({ element, index: Number(match![2]) * 12 + month, text });
    }
    return found;
  };
  const POPOVER = "[role=dialog],dialog,[data-popper-placement],[role=application],[role=grid],[role=listbox],[aria-modal=true]";
  /** Calendar month headings only: inside a popover/dialog or directly above a month's day grid, never a chart label. */
  const captions = () => rawCaptions().filter(({ element }) => Boolean(element.closest(POPOVER)) || monthGrid(element) !== null);
  const monthIndexOf = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
  const unavailable = (element: Element) => element.getAttribute("aria-disabled") === "true" || (element as HTMLButtonElement).disabled || element.hasAttribute("data-outside") || /\b(?:outside|disabled|blocked)\b/i.test(String(element.getAttribute("class") ?? "").replace(/[_-]/g, " "));
  /** The month's own grid: the smallest ancestor of its heading holding day numbers and no other month heading. */
  const monthGrid = (caption: Element) => {
    for (let node: Element | null = caption.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      const headings = rawCaptions().filter(({ element }) => node!.contains(element));
      if (headings.length > 1) return null;
      if (Array.from(node.querySelectorAll("td,[role=gridcell],button,[role=button]")).filter((cell) => /^\d{1,2}$/.test(ownText(cell))).length >= 28) return node;
    }
    return null;
  };
  /** The exact day cell for `iso`: its accessible date first (aria-label, data-date, datetime), else its number in its own month's grid. */
  const dayCell = (iso: string): { element: HTMLElement; via: string } | null => {
    const candidates = Array.from(document.querySelectorAll("td,[role=gridcell],button,[role=button],[data-date],[data-day],time[datetime]")).filter((element) => visibleNow(element) && !element.closest("input"));
    for (const element of candidates) {
      const dated = element.getAttribute("data-date") ?? element.getAttribute("data-day") ?? element.getAttribute("datetime") ?? element.querySelector("time[datetime]")?.getAttribute("datetime");
      const via = dated && (parseDisplayedDate(dated) ?? parseLabelDate(dated)) === iso ? "data-date" : parseLabelDate(element.getAttribute("aria-label")) === iso ? "aria-label" : null;
      if (!via || unavailable(element)) continue;
      const clickable = (element.matches("button,[role=button],[role=gridcell]") ? element : element.querySelector("button,[role=button]") ?? element) as HTMLElement;
      return { element: clickable, via };
    }
    const caption = captions().find(({ index }) => index === monthIndexOf(iso));
    const grid = caption && monthGrid(caption.element);
    if (!grid) return null;
    const day = String(Number(iso.slice(8, 10)));
    const cells = Array.from(grid.querySelectorAll("td,[role=gridcell],button,[role=button]")).filter((cell) => ownText(cell) === day && visibleNow(cell) && !unavailable(cell) && !(cell.parentElement && unavailable(cell.parentElement)));
    const distinct = cells.filter((cell) => !cells.some((other) => other !== cell && cell.contains(other)));
    return distinct.length === 1 ? { element: distinct[0] as HTMLElement, via: "day-number-in-month-grid" } : null;
  };
  /** Previous/next-month buttons beside the painted headings; never the dialog's own "Previous period" picker. */
  const navButton = (direction: "previous" | "next"): HTMLElement | null => {
    const heading = captions()[0]?.element; if (!heading) return null;
    const pattern = direction === "previous" ? /\b(?:prev|previous|back|backward)\b/i : /\b(?:next|forward)\b/i;
    for (let node: Element | null = heading.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
      const buttons = Array.from(node.querySelectorAll("button,[role=button]")).filter((button) => visibleNow(button) && !/\bperiod\b|\byear\b/i.test(labelOf(button)) && !/^\d{1,2}$/.test(ownText(button)));
      const labelled = buttons.find((button) => pattern.test(labelOf(button)));
      if (labelled) return labelled as HTMLElement;
      const iconOnly = buttons.filter((button) => !labelOf(button));
      if (iconOnly.length === 2) return iconOnly[direction === "previous" ? 0 : 1] as HTMLElement;
    }
    return null;
  };
  /** Everything a later diagnosis needs about the real picker, without page content or personal data. */
  const describePicker = (fields: Fields | null): Record<string, unknown> => {
    const combined = fields ? (() => { for (let node: Element | null = fields.start.parentElement; node; node = node.parentElement) if (node.contains(fields.end)) return node; return null; })() : null;
    const dayLike = Array.from(document.querySelectorAll("td,[role=gridcell],button,[role=button],[data-date],time[datetime]")).filter((element) => visibleNow(element) && (/^\d{1,2}$/.test(ownText(element)) || parseLabelDate(element.getAttribute("aria-label")) !== null || element.hasAttribute("data-date")));
    return {
      combinedControl: combined ? { tag: combined.tagName.toLowerCase(), role: combined.getAttribute("role"), ariaLabel: combined.getAttribute("aria-label"), className: String(combined.getAttribute("class") ?? "").slice(0, 120), text: ownText(combined).slice(0, 80), buttons: Array.from(combined.querySelectorAll("button,[role=button]")).map(labelOf).slice(0, 6) } : null,
      fields: fields ? [fields.start, fields.end].map((input) => ({ placeholder: input.placeholder, value: input.value, type: input.type, readOnly: input.readOnly, ariaHaspopup: input.getAttribute("aria-haspopup"), ariaExpanded: input.getAttribute("aria-expanded"), role: input.getAttribute("role"), className: String(input.getAttribute("class") ?? "").slice(0, 80) })) : null,
      dialogs: Array.from(document.querySelectorAll("[role=dialog],dialog,[data-popper-placement],[role=application],[role=grid]")).filter(visibleNow).map((element) => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaLabel: element.getAttribute("aria-label"), className: String(element.getAttribute("class") ?? "").slice(0, 80) })).slice(0, 8),
      monthHeadings: captions().map(({ text }) => text).slice(0, 4),
      navButtons: { previous: navButton("previous") ? labelOf(navButton("previous")!) || "(icon)" : null, next: navButton("next") ? labelOf(navButton("next")!) || "(icon)" : null },
      dayCells: { count: dayLike.length, sample: dayLike.slice(0, 6).map((cell) => ({ tag: cell.tagName.toLowerCase(), role: cell.getAttribute("role"), ariaLabel: cell.getAttribute("aria-label"), dataDate: cell.getAttribute("data-date"), className: String(cell.getAttribute("class") ?? "").slice(0, 80), text: ownText(cell).slice(0, 20) })) },
      contentEditable: document.querySelectorAll("[contenteditable=true]").length,
      // Short painted texts naming a month or year (calendar headings, however they are split), and popover texts.
      yearTexts: (() => { const out: string[] = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node = walker.nextNode(); node && out.length < 12; node = walker.nextNode()) { const text = (node.textContent ?? "").trim(); const parent = node.parentElement; if (text.length <= 30 && /\b20\d{2}\b|^(?:january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(text) && parent && visibleNow(parent) && !parent.closest("nav,aside")) out.push(`${parent.tagName.toLowerCase()}${parent.getAttribute("role") ? `[${parent.getAttribute("role")}]` : ""}: ${text}`); } return out; })(),
      popoverTexts: Array.from(document.querySelectorAll("[data-popper-placement],[role=dialog],dialog,[role=grid],[role=application]")).filter(visibleNow).map((element) => ownText(element).slice(0, 160)).slice(0, 4),
    };
  };
  const press = (element: HTMLElement) => { element.scrollIntoView?.({ block: "nearest", inline: "nearest" }); element.click(); };

  /** Enter + blur: what Klaviyo's fields commit a typed date on. */
  const commit = (input: HTMLInputElement) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur")); input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  };

  const enterDateRange = async (request: EntryRequest): Promise<EntryResult> => {
    const attempts: EntryAttempt[] = [];
    const observe = (): [string, string] | null => { const fields = request.fields(); return fields ? [fields.start.value, fields.end.value] : null; };
    const matches = () => { const now = observe(); return Boolean(now && parseDisplayedDate(now[0]) === request.startDate && parseDisplayedDate(now[1]) === request.endDate); };
    // Fields that already display the report dates may still hold stale, uncommitted state: commit them as shown.
    if (matches()) {
      for (const which of ["start", "end"] as const) { const live = request.fields(); if (live) { live[which].focus(); commit(live[which]); await settle(); } }
      if (matches()) return { ok: true, strategy: null, attempts, pickerValuesEntered: observe(), observed: observe(), reason: null, pickerStructure: null, calendar: null };
    }
    let pickerStructure: Record<string, unknown> | null = null; let calendar: CalendarDetail | null = null;
    const runCalendar = async (): Promise<CalendarDetail> => {
      const detail: CalendarDetail = { openedBy: null, calendarMonthBefore: captions().map(({ text }) => text), navigation: [], datesClicked: [], rangeAfterSelection: null, failure: null };
      const open = async () => {
        if (captions().length) return true;
        const fields = request.fields();
        // Clicking the start of the range control is what opens the calendar for a person.
        for (const [name, target] of [["start-field", fields?.start], ["range-control", fields?.start.parentElement]] as const) {
          if (!target) continue;
          (target as HTMLElement).focus?.(); press(target as HTMLElement); await settle(); await settle();
          pickerStructure = { ...pickerStructure, [`afterClick:${name}`]: describePicker(request.fields()) };
          if (captions().length) { detail.openedBy = name; return true; }
        }
        return false;
      };
      if (!await open()) { detail.failure = "No calendar opened from the date-range control."; return detail; }
      if (!detail.calendarMonthBefore.length) detail.calendarMonthBefore = captions().map(({ text }) => text);
      pickerStructure = { ...pickerStructure, afterOpen: describePicker(request.fields()) };
      const navigateTo = async (iso: string) => {
        const target = monthIndexOf(iso); let stalled = 0;
        // As many month steps as the painted calendar needs, in either direction; never a fixed count.
        for (let step = 0; step < 600; step += 1) {
          const shown = captions().map(({ index }) => index);
          if (!shown.length) { if (!await open()) return false; continue; }
          if (target >= Math.min(...shown) && target <= Math.max(...shown)) return true;
          const direction = target < Math.min(...shown) ? "previous" : "next";
          const button = navButton(direction); if (!button) { detail.failure = `No ${direction}-month button beside the calendar.`; return false; }
          const before = captions().map(({ text }) => text).join("|");
          press(button); await settle();
          detail.navigation.push(direction);
          if (captions().map(({ text }) => text).join("|") === before) { stalled += 1; if (stalled >= 3) { detail.failure = `The calendar did not move ${direction}.`; return false; } } else stalled = 0;
        }
        detail.failure = "The calendar could not reach the report month."; return false;
      };
      for (const iso of [request.startDate, request.endDate]) {
        if (!await navigateTo(iso)) return detail;
        const cell = dayCell(iso);
        if (!cell) { detail.failure = `No exact day cell for ${iso}.`; return detail; }
        press(cell.element); await settle(); await settle();
        detail.datesClicked.push({ iso, via: cell.via, label: labelOf(cell.element).slice(0, 80) });
        // Some pickers close after the start day; the end field reopens them on the end month.
        if (iso === request.startDate && !captions().length) { const end = request.fields()?.end; if (end) { end.focus(); press(end); await settle(); await settle(); } }
      }
      detail.rangeAfterSelection = observe();
      return detail;
    };
    const run = async (afterReselect: boolean): Promise<EntryResult | null> => {
      for (const strategy of ["calendar", "set-value", "insert-text", "type-keys"] as const) {
        const fields = request.fields();
        if (!fields) return { ok: false, strategy: null, attempts, pickerValuesEntered: null, observed: null, reason: "The date fields disappeared before the report dates could be entered.", pickerStructure, calendar };
        if (strategy === "calendar") {
          pickerStructure = pickerStructure ?? { beforeOpen: describePicker(fields) };
          calendar = await runCalendar();
          const observed = observe() ?? ["", ""];
          const matched = matches();
          attempts.push({ strategy, order: "start-first", entered: [request.startDate, request.endDate], observed, matched, afterReselect });
          if (matched) return { ok: true, strategy, attempts, pickerValuesEntered: [request.startDate, request.endDate], observed, reason: null, pickerStructure, calendar };
          continue;
        }
        const context = [fields.start.value, fields.end.value];
        const startText = (request.format ?? ((input, iso) => formatLike(input, iso, context)))(fields.start, request.startDate);
        const endText = (request.format ?? ((input, iso) => formatLike(input, iso, context)))(fields.end, request.endDate);
        // A start after the range currently shown would make an interim invalid range; then the end goes first.
        const currentEnd = parseDisplayedDate(fields.end.value);
        const order = currentEnd && request.startDate > currentEnd ? "end-first" as const : "start-first" as const;
        const steps: Array<["start" | "end", string]> = order === "start-first" ? [["start", startText], ["end", endText]] : [["end", endText], ["start", startText]];
        let supported = true;
        for (const [which, text] of steps) {
          const live = request.fields(); if (!live) break;
          if (!write(live[which], text, strategy)) { supported = false; break; }
          await settle();
          const after = request.fields(); if (after) commit(after[which]);
          await settle();
        }
        await settle();
        const observed = observe() ?? ["", ""];
        const matched = supported && matches();
        attempts.push({ strategy, order, entered: [startText, endText], observed, matched, afterReselect });
        if (matched) return { ok: true, strategy, attempts, pickerValuesEntered: [startText, endText], observed, reason: null, pickerStructure, calendar };
      }
      return null;
    };
    const first = await run(false); if (first) return first;
    if (request.reselectCustom && await request.reselectCustom().catch(() => false)) {
      await settle();
      const second = await run(true); if (second) return second;
    }
    const last = attempts.at(-1);
    return { ok: false, strategy: null, attempts, pickerValuesEntered: last?.entered ?? null, observed: observe(), reason: "Klaviyo's date fields did not accept the report dates; Apply was not clicked.", pickerStructure, calendar };
  };

  /**
   * The selected range only. Klaviyo paints "<selected range> compared to <comparison range>" beside its Time period
   * control; the comparison half is never evidence of the selected period (Home showed "Oct 7 – Nov 6, 2026 compared to
   * Oct 1 – Oct 31, 2026" while Time period was "Last 30 days", run c80dcbab).
   */
  const currentPeriodText = (text: string): string => text.split(/\b(?:compared (?:to|with)|vs\.?|versus)\b/i)[0] ?? "";

  /**
   * The Time period part of Klaviyo's period dialog: its picker, the mode the picker shows ("Last 30 days", "Custom",
   * …), and only the date fields that belong to it — those before the "Comparison period" label. When Time period is a
   * preset, the only visible date fields may be the comparison's; they must never be taken for the report period.
   */
  const timePeriodSection = (open: Element) => {
    const isShown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return false;
      }
      return rect.width > 0 && rect.height > 0;
    };
    const text = (element: Element) => ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const isComparisonLabel = (element: Element) => /^comparison period$/i.test(text(element));
    const comparisonLabel = Array.from(open.querySelectorAll("*")).find((element) => isShown(element) && isComparisonLabel(element) && !Array.from(element.children).some(isComparisonLabel)) ?? null;
    const beforeComparison = (element: Element) => !comparisonLabel || Boolean(element.compareDocumentPosition(comparisonLabel) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pickers = Array.from(open.querySelectorAll("select,[role=combobox],button[aria-haspopup],[aria-haspopup=listbox],button"))
      .filter((element) => isShown(element) && beforeComparison(element) && !/^(?:apply|cancel)$/i.test(text(element)));
    const picker = pickers.find((element) => text(element).length > 0) ?? null;
    const pickerText = picker instanceof HTMLSelectElement ? (picker.selectedOptions[0]?.text ?? picker.value).trim() : picker ? text(picker) : "";
    const fieldText = (input: HTMLInputElement) => [input.getAttribute("aria-label"), input.placeholder, input.name, input.labels?.[0] ? text(input.labels[0]) : ""].filter(Boolean).join(" ");
    const fields = (): Fields | null => {
      const inputs = Array.from(open.querySelectorAll("input")).filter((input) => isShown(input) && beforeComparison(input) && !input.disabled && !input.readOnly
        && !["hidden", "checkbox", "radio", "search", "file"].includes(input.type) && input.getAttribute("role") !== "combobox");
      const start = inputs.find((input) => /start|from/i.test(fieldText(input))) ?? null;
      const end = start ? inputs.slice(inputs.indexOf(start) + 1).find((input) => /end|\bto\b/i.test(fieldText(input))) ?? null : null;
      return start && end ? { start, end } : null;
    };
    // A dialog without a preset picker holds only a custom range; a preset ("Last 30 days", …) is never custom.
    return { picker, pickerText, isCustom: !picker || /^custom\b/i.test(pickerText), hasComparison: Boolean(comparisonLabel), fields };
  };

  (globalThis as unknown as { __tentionPeriodEntry?: unknown }).__tentionPeriodEntry = { version: 3, parseDisplayedDate, parseLabelDate, formatLike, enterDateRange, describePicker, currentPeriodText, timePeriodSection };
})();
