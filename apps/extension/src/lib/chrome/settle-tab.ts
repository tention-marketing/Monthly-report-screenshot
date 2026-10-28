/** The recovery actions a navigation layer honours for one attempt (see automatic-capture/recovery-policy.ts). */
export interface AttemptRecovery { readonly actions?: readonly string[] }

export function recoveryRequests(recovery: AttemptRecovery | null | undefined, action: string): boolean {
  return Boolean(recovery?.actions?.includes(action));
}

/**
 * Waits until the tab has reported a complete load continuously for `settleMs` (bounded by `maxMs`), so an adapter is
 * not injected into a document that is still loading or about to be replaced.
 */
export async function waitForSettledTab(tabs: { get(tabId: number): Promise<{ status?: string }> }, tabId: number, settleMs = 1_500, maxMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + maxMs; let completeSince: number | null = null;
  while (Date.now() < deadline) {
    const tab = await tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") { completeSince ??= Date.now(); if (Date.now() - completeSince >= settleMs) return true; }
    else completeSince = null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
