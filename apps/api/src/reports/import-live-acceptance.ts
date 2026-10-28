import { createApiClient } from "@tention/api-client";
import { deriveClientId } from "@tention/report-domain";
import { clientReportTargetsSchema, reportDraftSchema } from "@tention/report-schema";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_ACCEPTANCE_IMPORT_TYPES, readLocalClient } from "./live-acceptance-artifacts.js";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const baseUrl = args.apiBaseUrl.replace(/\/$/, "");
if (!isLoopbackHttp(baseUrl)) fail("The import bridge only permits an HTTP loopback API URL.");

const api = createApiClient({ baseUrl });
try {
  await api.health();
  const client = await readLocalClient(repositoryRoot, args.clientId);
  const drafts = await api.listReportDrafts({ clientId: args.clientId, year: args.reportMonth.year, month: args.reportMonth.month });
  if (drafts.length > 1) fail("More than one draft exists for this configured client and report month; refusing to select or create another.");
  if (drafts.length === 1 && (drafts[0]!.client.name !== client.name || drafts[0]!.client.timezone !== client.timezone)) {
    fail("The existing report identity does not match the configured local client.");
  }
  const response = await fetch(`${baseUrl}/api/v1/dev/live-acceptance/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: args.clientId, reportMonth: args.reportMonth, ...(args.section ? { section: args.section } : {}) }),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) fail(typeof body?.message === "string" ? body.message : `Import failed with status ${response.status}.`);
  const result = z.object({ reportId: z.string().uuid(), clientId: z.string(), reportMonth: z.object({ year: z.number().int(), month: z.number().int() }), importedCaptureCount: z.number().int(), pendingReviewCount: z.number().int(), reusedCaptureCount: z.number().int(), storageVerifiedCount: z.number().int(), sourceProofVerifiedCount: z.number().int(), distinctSha256Count: z.number().int(), importedTypes: z.array(z.string()), missingTypes: z.array(z.string()), validation: z.unknown() }).parse(body);
  if (result.clientId !== args.clientId || result.reportMonth.year !== args.reportMonth.year || result.reportMonth.month !== args.reportMonth.month) fail("The import acknowledgement identity does not match the requested client and month.");
  const after = await api.listReportDrafts({ clientId: args.clientId, year: args.reportMonth.year, month: args.reportMonth.month });
  if (after.length !== 1 || after[0]!.id !== result.reportId) fail("Post-import API query did not return exactly the canonical report draft.");
  const draft = reportDraftSchema.parse(await api.getReportDraft(result.reportId));
  if (draft.client.id !== args.clientId || draft.client.name !== client.name || draft.client.timezone !== client.timezone || draft.reportMonth.year !== args.reportMonth.year || draft.reportMonth.month !== args.reportMonth.month) fail("Canonical report identity does not match the requested client and month.");
  const importedScope = args.section ? draft.screenshots.filter((shot) => shot.type === args.section) : draft.screenshots.filter((shot) => shot.captureOrigin === "live_acceptance_import");
  if (importedScope.some((shot) => shot.captureOrigin !== "live_acceptance_import" || shot.approved || shot.approvedAt !== null)) fail("The newly imported acceptance evidence was unexpectedly approved or did not retain its import origin.");
  const targets = clientReportTargetsSchema.parse(await api.getClientReportTargets(args.clientId));
  // A sparse local capture config must not clear or fail unrelated persisted
  // section targets. When a scope is explicitly configured here, require it
  // to survive the import; otherwise leave the existing target untouched.
  if ((client.signupForms && targets.signupForms?.mode !== client.signupForms.mode)
    || (client.welcomeFlowListing && (targets.welcomeFlowListing?.mode !== client.welcomeFlowListing.mode || targets.welcomeFlowListing.flows.length !== client.welcomeFlowListing.flows.length))) fail("Persisted listing target configuration does not match the configured client scope.");
  console.log(JSON.stringify({ status: "PASS", apiBaseUrl: baseUrl, reportId: draft.id, clientId: draft.client.id, clientName: draft.client.name, timezone: draft.client.timezone, reportMonth: draft.reportMonth, screenshotCount: draft.screenshots.length, importedCaptureCount: result.importedCaptureCount, pendingReviewCount: result.pendingReviewCount, reusedCaptureCount: result.reusedCaptureCount, storageVerifiedCount: result.storageVerifiedCount, sourceProofVerifiedCount: result.sourceProofVerifiedCount, distinctSha256Count: result.distinctSha256Count, missingTypes: result.missingTypes, validation: result.validation, reportQueryCount: after.length, targetConfiguration: { signupForms: targets.signupForms, welcomeFlowListing: targets.welcomeFlowListing, customerSegmentConfigured: Boolean(targets.customerSegment), nonCustomerSegmentConfigured: Boolean(targets.nonCustomerSegment), primaryEmailListConfigured: Boolean(targets.primaryEmailList) } }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : "Live acceptance import failed.");
}

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) fail("Arguments must use --name value form.");
    const value = values[index + 1];
    if (!value || value.startsWith("--") || parsed.has(key)) fail(`Missing or duplicate value for ${key}.`);
    parsed.set(key, value); index += 1;
  }
  const clientId = parsed.get("--client");
  const month = parsed.get("--month");
  const apiBaseUrl = parsed.get("--api-base-url") ?? "http://127.0.0.1:4000";
  const section = parsed.get("--section");
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!clientId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clientId) || !monthMatch || Number(monthMatch[2]) < 1 || Number(monthMatch[2]) > 12 || (section !== undefined && !(LIVE_ACCEPTANCE_IMPORT_TYPES as readonly string[]).includes(section))) fail(`Usage: npm run acceptance:import-live -- --client configured-client-id --month YYYY-MM [--section ${LIVE_ACCEPTANCE_IMPORT_TYPES.join("|")}] [--api-base-url http://127.0.0.1:4000]`);
  if ([...parsed.keys()].some((key) => !["--client", "--month", "--section", "--api-base-url"].includes(key))) fail("Unsupported import option.");
  return { clientId, reportMonth: { year: Number(monthMatch[1]), month: Number(monthMatch[2]) }, apiBaseUrl, section };
}
function isLoopbackHttp(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
function fail(message: string): never { console.error(`LIVE_ACCEPTANCE_IMPORT_FAILED: ${message}`); process.exit(1); }
