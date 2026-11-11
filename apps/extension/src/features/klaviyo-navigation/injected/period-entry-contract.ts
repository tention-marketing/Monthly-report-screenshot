/**
 * Types for the shared page helper in ./period-entry.ts, and its loader. Adapters reach the helper through
 * `globalThis.__tentionPeriodEntry` (type-only imports are erased, so serialized adapters stay self-contained).
 */
export const PERIOD_ENTRY_SCRIPT = "injected/period-entry.js";

export type PeriodEntryStrategy = "calendar" | "set-value" | "insert-text" | "type-keys";
export interface PeriodEntryAttempt { strategy: PeriodEntryStrategy; order: "start-first" | "end-first"; entered: [string, string]; observed: [string, string]; matched: boolean; afterReselect: boolean }
/** What the calendar strategy did: how it opened the picker, the months it stepped through, the exact days it clicked. */
export interface PeriodEntryCalendarDetail { openedBy: string | null; calendarMonthBefore: string[]; navigation: string[]; datesClicked: Array<{ iso: string; via: string; label: string }>; rangeAfterSelection: [string, string] | null; failure: string | null }
export interface PeriodEntryResult { ok: boolean; strategy: PeriodEntryStrategy | null; attempts: PeriodEntryAttempt[]; pickerValuesEntered: [string, string] | null; observed: [string, string] | null; reason: string | null; pickerStructure: Record<string, unknown> | null; calendar: PeriodEntryCalendarDetail | null }
export interface PeriodEntryApi {
  version: number;
  parseDisplayedDate(raw: string | null | undefined): string | null;
  parseLabelDate(raw: string | null | undefined): string | null;
  describePicker(fields: { start: HTMLInputElement; end: HTMLInputElement } | null): Record<string, unknown>;
  formatLike(input: HTMLInputElement, iso: string, context?: readonly string[]): string;
  /** The selected range only: text before "compared to" (the comparison half is never the report period). */
  currentPeriodText(text: string): string;
  /** The Time period picker, its shown mode, and only its own date fields (never the Comparison period's). */
  timePeriodSection(open: Element): { picker: Element | null; pickerText: string; isCustom: boolean; hasComparison: boolean; fields: () => { start: HTMLInputElement; end: HTMLInputElement } | null };
  enterDateRange(request: {
    fields: () => { start: HTMLInputElement; end: HTMLInputElement } | null;
    startDate: string; endDate: string;
    format?: (input: HTMLInputElement, iso: string) => string;
    reselectCustom?: () => Promise<boolean>;
  }): Promise<PeriodEntryResult>;
}

interface FileInjector { executeScript(details: { target: { tabId: number; frameIds: [number] }; files: string[] }): Promise<unknown> }

/**
 * Loads the shared period helper into the tab's main frame before a page adapter runs. Returns false (the adapter then
 * fails closed and captures nothing) when it cannot be loaded.
 */
export async function injectPeriodEntry(scripting: unknown, tabId: number): Promise<boolean> {
  try { await (scripting as FileInjector).executeScript({ target: { tabId, frameIds: [0] }, files: [PERIOD_ENTRY_SCRIPT] }); return true; }
  catch { return false; }
}
