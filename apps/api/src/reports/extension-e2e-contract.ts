export interface ExtensionE2eDraftIdentity {
  id: string;
  client: { id: string; name: string; timezone: string };
  reportMonth: { year: number; month: number };
}

export function findCanonicalE2eDrafts<T extends ExtensionE2eDraftIdentity>(drafts: T[], expected: { id: string; clientId: string; year: number; month: number }) {
  return drafts.filter((draft) => draft.id === expected.id && draft.client.id === expected.clientId
    && draft.reportMonth.year === expected.year && draft.reportMonth.month === expected.month);
}

/** Other clients' reports are valid in Recent Reports; only duplicate cards for this identity are an acceptance failure. */
export function findRecentReportCardsForIdentity(cardTexts: string[], expected: { clientName: string; monthLabel: string }): string[] {
  return cardTexts.filter((text) => text.includes(expected.clientName) && text.includes(expected.monthLabel));
}

export interface ExtensionE2eTarget { reportId: string; clientId: string; clientName: string; timezone: string; year: number; month: number; monthLabel: string; reviewPdfFileName: string; finalPdfFileName: string }

/** Canonical live-imported reports the real-extension E2E may run against. The
 * identity of each is asserted end to end; no target borrows another's data. */
export const EXTENSION_E2E_TARGETS: Readonly<Record<string, ExtensionE2eTarget>> = {
  autoledtech: { reportId: "f577d631-a1f6-4cc0-9052-68e30460876d", clientId: "autoledtech", clientName: "AutoLEDTech.com", timezone: "America/New_York", year: 2026, month: 8, monthLabel: "August 2026", reviewPdfFileName: "AutoLEDTech-2026-08-Performance-Review.pdf", finalPdfFileName: "AutoLEDTech-August-2026-Monthly-Report.pdf" },
  "club-furniture": { reportId: "701a35ea-461a-40d8-8cdf-76c59a40e0a0", clientId: "club-furniture", clientName: "Club Furniture", timezone: "America/New_York", year: 2026, month: 8, monthLabel: "August 2026", reviewPdfFileName: "Club-Furniture-2026-08-Performance-Review.pdf", finalPdfFileName: "Club-Furniture-August-2026-Monthly-Report.pdf" },
};

export function selectExtensionE2eTarget(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): ExtensionE2eTarget {
  const index = argv.indexOf("--client");
  const key = (index >= 0 ? argv[index + 1] : undefined) ?? env.TENTION_E2E_CLIENT ?? "autoledtech";
  const target = EXTENSION_E2E_TARGETS[key];
  if (!target) throw new Error(`Unknown extension E2E client "${key}". Use one of: ${Object.keys(EXTENSION_E2E_TARGETS).join(", ")}.`);
  return target;
}
