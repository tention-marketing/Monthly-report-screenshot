import { getReportPeriod, isCompletedMonthAtInstant } from "@tention/report-core";
import { ReportPersistenceError } from "./persistence-error.js";
export * from "./persistence-error.js";
export * from "./client-report-targets.js";
export * from "./client-id.js";
import {
  isAcceptedCapture, isValidIanaTimeZone, matchesReportCaptureSpec, REPORT_CAPTURE_SPEC_V1, reportCaptureSpecByScreenshotType, TOP_CAMPAIGNS_LIMIT, reportSectionKeySchema, screenshotSectionMapping,
  type ClientSummary, type ReportDraft, type ReportMonth, type ReportSectionKey,
  type ReportStatus, type ReportValidationIssue, type ReportValidationState,
  reportDraftSchema, reportLifecycleEventSchema, type ReportLifecycleEvent,
  type ScreenshotRecord, type ScreenshotType, type SectionConfiguration, type ReportPdfArtifact, type ReportPdfDriveDelivery, type ReportGoogleDoc, type ReportCaptureSpec, type CapturePeriodProof,
} from "@tention/report-schema";

export type ValidationIssueCode =
  | "REPORT_MONTH_INCOMPLETE" | "INVALID_CLIENT_TIMEZONE" | "REPORT_PERIOD_MISMATCH"
  | "SCREENSHOT_CLIENT_MISMATCH" | "SCREENSHOT_MONTH_MISMATCH" | "SCREENSHOT_TYPE_MISMATCH"
  | "REQUIRED_SCREENSHOT_MISSING" | "REQUIRED_SCREENSHOT_UNAPPROVED"
  | "REQUIRED_SCREENSHOT_PERIOD_UNCONFIRMED" | "REQUIRED_SCREENSHOT_ASSET_MISSING"
  | "DUPLICATE_SCREENSHOT_TYPE" | "DUPLICATE_SCREENSHOT_SOURCE" | "SCREENSHOT_SOURCE_PROOF_MISSING" | "SCREENSHOT_SOURCE_IDENTITY_MISMATCH" | "SCREENSHOT_SOURCE_URL_MISMATCH" | "SCREENSHOT_SOURCE_PERIOD_MISMATCH" | "DISABLED_SECTION_SCREENSHOT_PRESENT"
  | "UNKNOWN_SECTION_CONFIGURATION";

export type ReportEvent =
  | "START_DATA_FETCH" | "DATA_FETCH_SUCCEEDED" | "DATA_FETCH_FAILED"
  | "MARK_CAPTURES_INCOMPLETE" | "SUBMIT_FOR_REVIEW" | "APPROVE"
  | "START_GENERATION" | "GENERATION_SUCCEEDED" | "GENERATION_FAILED" | "RESET_TO_DRAFT"
  | "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW" | "AUTO_VALIDATE";

export interface DomainContext { now: Date }
export interface CreateReportDraftInput {
  client: ClientSummary;
  reportMonth: ReportMonth;
  sections: SectionConfiguration;
}
export interface CreateReportDraftContext extends DomainContext { id?: string }

export class ReportDomainError extends Error {
  constructor(
    public readonly code: "ILLEGAL_REPORT_TRANSITION" | "REPORT_VALIDATION_FAILED" | ValidationIssueCode,
    message: string,
    public readonly validation?: ReportValidationState,
  ) { super(message); this.name = "ReportDomainError"; }
}

export function createReportDraft(input: CreateReportDraftInput, context: CreateReportDraftContext): ReportDraft {
  const timestamp = validInstant(context.now).toISOString();
  const draft: ReportDraft = {
    id: context.id ?? crypto.randomUUID(),
    client: input.client,
    reportMonth: input.reportMonth,
    period: getReportPeriod(input.reportMonth),
    status: "draft",
    sections: { ...input.sections },
    screenshots: [],
    validation: { status: "pending", errors: [], warnings: [] },
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ...draft, validation: validateReportDraft(draft, context) };
}

/** Removes retired List Growth from an active draft without deleting its historical evidence. */
export function retireLegacyListGrowth(draft: ReportDraft, context: DomainContext): ReportDraft {
  if (!("list_growth" in draft.sections)) return draft;
  const { list_growth: _retired, ...sections } = draft.sections;
  const next = { ...draft, sections, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
  return { ...next, validation: validateReportDraft(next, context) };
}

/**
 * Adds Section 10 (Subscriber Growth) to an existing draft on explicit request. It never touches legacy List Growth,
 * never migrates its evidence, and leaves every other section and screenshot unchanged.
 */
export function enableEmailSubscriberGrowth(draft: ReportDraft, context: DomainContext): ReportDraft {
  if (draft.status === "generated") throw new ReportDomainError("REPORT_VALIDATION_FAILED", "A generated report cannot gain a new section.");
  if (draft.sections.email_subscriber_growth === "required") return draft;
  const next = { ...draft, sections: { ...draft.sections, email_subscriber_growth: "required" as const }, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
  return { ...next, validation: validateReportDraft(next, context) };
}

/**
 * Explicit data-definition update: fills a report's frozen currency from the client's verified profile currency. Only
 * `client.currency` (plus version, updatedAt and recomputed validation) changes — never the report ID, month, period,
 * sections, screenshots, hashes, approvals, sources or capture proofs. A currency already frozen on the report is never
 * replaced by a different one, and a report that is generating or generated is never changed.
 */
export function applyClientProfileCurrency(draft: ReportDraft, profileCurrency: string | null | undefined, context: DomainContext): ReportDraft {
  if (draft.status === "generating" || draft.status === "generated") throw new ReportDomainError("REPORT_VALIDATION_FAILED", "A generating or generated report's currency cannot change.");
  if (!profileCurrency || !/^[A-Z]{3}$/.test(profileCurrency)) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "The client profile has no verified ISO currency code to apply.");
  if (draft.client.currency === profileCurrency) return draft;
  if (draft.client.currency !== null) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `This report is already frozen in ${draft.client.currency}; it is not changed to ${profileCurrency}.`);
  const next = { ...draft, client: { ...draft.client, currency: profileCurrency }, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
  return { ...next, validation: validateReportDraft(next, context) };
}

export function validateReportDraft(draft: ReportDraft, context: DomainContext): ReportValidationState {
  const errors: ReportValidationIssue[] = [];
  const warnings: ReportValidationIssue[] = [];
  const issue = (code: ValidationIssueCode, severity: "error" | "warning", message: string, details: Partial<ReportValidationIssue> = {}) => {
    (severity === "error" ? errors : warnings).push({ code, severity, message, ...details });
  };

  if (!isValidIanaTimeZone(draft.client.timezone)) {
    issue("INVALID_CLIENT_TIMEZONE", "error", "Client timezone must be a valid IANA timezone.", { field: "client.timezone" });
  } else if (!isCompletedMonthAtInstant(draft.reportMonth, validInstant(context.now), draft.client.timezone)) {
    issue("REPORT_MONTH_INCOMPLETE", "error", "Report month must be complete in the client's timezone.", { field: "reportMonth" });
  }

  if (JSON.stringify(draft.period) !== JSON.stringify(getReportPeriod(draft.reportMonth))) {
    issue("REPORT_PERIOD_MISMATCH", "error", "Stored period does not match the derived report month.", { field: "period" });
  }

  const knownSections = new Set<string>(reportSectionKeySchema.options);
  for (const section of Object.keys(draft.sections)) {
    if (!knownSections.has(section)) {
      issue("UNKNOWN_SECTION_CONFIGURATION", "error", `Unknown report section: ${section}.`, { field: `sections.${section}` });
    }
  }

  const byType = new Map<ScreenshotType, ScreenshotRecord[]>();
  for (const screenshot of draft.screenshots) {
    const matches = byType.get(screenshot.type) ?? [];
    matches.push(screenshot);
    byType.set(screenshot.type, matches);
    if (screenshot.clientId !== draft.client.id) issue("SCREENSHOT_CLIENT_MISMATCH", "error", "Screenshot belongs to another client.", { screenshotType: screenshot.type });
    if (!sameMonth(screenshot.reportMonth, draft.reportMonth)) issue("SCREENSHOT_MONTH_MISMATCH", "error", "Screenshot metadata belongs to another report month.", { screenshotType: screenshot.type });
    const section = screenshotSectionMapping[screenshot.type];
    if (screenshot.type === "list_growth") continue; // retained only so historical drafts remain readable.
    if (draft.sections[section] === "disabled") issue("DISABLED_SECTION_SCREENSHOT_PRESENT", "warning", "A disabled section has screenshot metadata.", { section, screenshotType: screenshot.type });
    if (draft.sections[section] !== "disabled") validateSourceProof(screenshot, reportCaptureSpecByScreenshotType[screenshot.type], draft, issue);
  }

  for (const [type, screenshots] of byType) {
    if (screenshots.length > 1) issue("DUPLICATE_SCREENSHOT_TYPE", "error", "More than one screenshot exists for the same type.", { screenshotType: type });
  }
  const byHash = new Map<string, ScreenshotRecord[]>();
  for (const screenshot of draft.screenshots) {
    const section = screenshotSectionMapping[screenshot.type];
    if (screenshot.type === "list_growth" || draft.sections[section] === "disabled" || !screenshot.sha256) continue;
    byHash.set(screenshot.sha256, [...(byHash.get(screenshot.sha256) ?? []), screenshot]);
  }
  for (const screenshots of byHash.values()) {
    const sectionKeys = [...new Set(screenshots.map((screenshot) => reportCaptureSpecByScreenshotType[screenshot.type].key))];
    if (sectionKeys.length > 1) issue("DUPLICATE_SCREENSHOT_SOURCE", "error", `${captureTitle(sectionKeys[0]!)} and ${captureTitle(sectionKeys[1]!)} use the same screenshot asset.`, { field: "screenshots" });
  }

  for (const [type, section] of Object.entries(screenshotSectionMapping) as [ScreenshotType, ReportSectionKey][]) {
    if (type === "list_growth") continue;
    if (!isCurrentRequiredCapture(section, draft)) continue;
    const candidates = (byType.get(type) ?? []).filter((screenshot) =>
      screenshot.clientId === draft.client.id && sameMonth(screenshot.reportMonth, draft.reportMonth));
    if (candidates.length === 0) {
      issue("REQUIRED_SCREENSHOT_MISSING", "error", "A required section is missing screenshot metadata.", { section, screenshotType: type });
    } else if (!candidates.some(isAcceptedCapture)) {
      issue("REQUIRED_SCREENSHOT_UNAPPROVED", "error", "A required screenshot has not been approved or machine-validated.", { section, screenshotType: type });
    } else if (!candidates.some((candidate) => isAcceptedCapture(candidate) && candidate.periodConfirmed)) {
      issue("REQUIRED_SCREENSHOT_PERIOD_UNCONFIRMED", "error", "A required screenshot needs human report-period confirmation.", { section, screenshotType: type });
    } else if (!candidates.some(hasStoredApprovedAsset)) {
      issue("REQUIRED_SCREENSHOT_ASSET_MISSING", "error", "A required screenshot is missing its stored PNG asset metadata.", { section, screenshotType: type });
    }
  }
  return { status: errors.length === 0 ? "valid" : "invalid", errors, warnings };
}

function isCurrentRequiredCapture(section: ReportSectionKey, draft: ReportDraft): boolean {
  const spec = REPORT_CAPTURE_SPEC_V1.find((candidate) => candidate.key === section);
  return draft.sections[section] !== undefined && (spec?.automationStatus === "auto" || draft.sections[section] === "required");
}

function validateSourceProof(screenshot: ScreenshotRecord, spec: ReportCaptureSpec, draft: ReportDraft, issue: (code: ValidationIssueCode, severity: "error" | "warning", message: string, details?: Partial<ReportValidationIssue>) => void): void {
  const proof = screenshot.sourceProof;
  if (!proof) { issue("SCREENSHOT_SOURCE_PROOF_MISSING", "error", `${spec.title} screenshot is missing source proof.`, { screenshotType: screenshot.type }); return; }
  if (!matchesReportCaptureSpec(screenshot.type, proof)) {
    issue("SCREENSHOT_SOURCE_IDENTITY_MISMATCH", "error", `${spec.title} screenshot source identity does not match its capture specification.`, { screenshotType: screenshot.type });
  }
  if (screenshot.type === "top_campaigns" && (!proof.campaigns || proof.campaigns.includedRowCount !== proof.campaigns.rows.length || proof.campaigns.includedRowCount > TOP_CAMPAIGNS_LIMIT || proof.campaigns.includedRowCount !== Math.min(TOP_CAMPAIGNS_LIMIT, proof.campaigns.eligibleRowCount) || !proof.campaigns.rows.every((row) => row.status === "Sent"))) {
    issue("SCREENSHOT_SOURCE_IDENTITY_MISMATCH", "error", "Top Campaigns screenshot is missing complete Sent-campaign ranking evidence.", { screenshotType: screenshot.type });
  }
  if (screenshot.type === "deliverability" && screenshot.sourceUrl && !isStandaloneDeliverabilityScoreUrl(screenshot.sourceUrl)) {
    issue("SCREENSHOT_SOURCE_URL_MISMATCH", "error", "Deliverability evidence must come from the standalone Klaviyo Deliverability Score Email page.", { screenshotType: screenshot.type });
  }
  if (screenshot.type === "top_campaigns" && (!screenshot.sourceUrl || !isCampaignsListUrl(screenshot.sourceUrl))) {
    issue("SCREENSHOT_SOURCE_URL_MISMATCH", "error", "Top Campaigns evidence must come from the Klaviyo Campaigns listing (/omnicampaigns).", { screenshotType: screenshot.type });
  }
  if (screenshot.type === "email_subscriber_growth" && (!screenshot.sourceUrl || !isKlaviyoHttpsUrl(screenshot.sourceUrl))) {
    issue("SCREENSHOT_SOURCE_URL_MISMATCH", "error", "Subscriber Growth evidence must come from the Klaviyo Subscriber growth page.", { screenshotType: screenshot.type });
  }
  if (spec.sourceFamily === "klaviyo-home" && screenshot.sourceUrl && !isKlaviyoHomeUrl(screenshot.sourceUrl)) {
    issue("SCREENSHOT_SOURCE_URL_MISMATCH", "error", `${spec.title} evidence must come from the Klaviyo Home dashboard.`, { screenshotType: screenshot.type });
  }
  const expected = expectedPeriod(spec, draft);
  if (JSON.stringify(proof.expectedPeriod) !== JSON.stringify(expected) || (expected !== null && JSON.stringify(proof.observedPeriod) !== JSON.stringify(expected))) {
    issue("SCREENSHOT_SOURCE_PERIOD_MISMATCH", "error", `${spec.title} screenshot source period does not match its capture policy.`, { screenshotType: screenshot.type });
  }
}
function isKlaviyoHomeUrl(sourceUrl: string): boolean {
  try { return /^\/dashboard\/?$/i.test(new URL(sourceUrl).pathname); } catch { return false; }
}
function isStandaloneDeliverabilityScoreUrl(sourceUrl: string | null): boolean {
  if (!sourceUrl) return false;
  try {
    const url = new URL(sourceUrl);
    return /(^|\/)analytics\/deliverability\/email\/score\/?$/i.test(url.pathname);
  } catch { return false; }
}
function isKlaviyoHttpsUrl(sourceUrl: string): boolean {
  try { const url = new URL(sourceUrl); return url.protocol === "https:" && (url.hostname === "klaviyo.com" || url.hostname.endsWith(".klaviyo.com")); } catch { return false; }
}
function isCampaignsListUrl(sourceUrl: string): boolean {
  try { return /^\/omnicampaigns\/?$/i.test(new URL(sourceUrl).pathname); } catch { return false; }
}
function expectedPeriod(spec: ReportCaptureSpec, draft: ReportDraft): CapturePeriodProof | null {
  if (spec.datePolicy === "EXACT_MONTH") return { startDate: draft.period.startDate, endDate: draft.period.endDate };
  if (spec.datePolicy === "PREVIOUS_MONTH_COMPARISON") return { startDate: draft.period.startDate, endDate: draft.period.endDate, comparisonStartDate: draft.period.previousStartDate, comparisonEndDate: draft.period.previousEndDate };
  return null;
}
function captureTitle(key: string): string { return key.split("_").map((value) => value[0]!.toUpperCase() + value.slice(1)).join(" "); }

const transitions: Partial<Record<ReportStatus, Partial<Record<ReportEvent, ReportStatus>>>> = {
  draft: { START_DATA_FETCH: "data_fetching", SUBMIT_FOR_REVIEW: "ready_for_review", AUTO_VALIDATE: "auto_validated" },
  data_fetching: { DATA_FETCH_SUCCEEDED: "data_ready", DATA_FETCH_FAILED: "failed" },
  data_ready: { MARK_CAPTURES_INCOMPLETE: "captures_incomplete", SUBMIT_FOR_REVIEW: "ready_for_review", AUTO_VALIDATE: "auto_validated" },
  captures_incomplete: { SUBMIT_FOR_REVIEW: "ready_for_review", AUTO_VALIDATE: "auto_validated" },
  ready_for_review: { MARK_CAPTURES_INCOMPLETE: "captures_incomplete", START_GENERATION: "generating" },
  approved: { START_GENERATION: "generating" },
  // Machine-validated automatic captures generate without a human approval step; a retake re-validates.
  auto_validated: { AUTO_VALIDATE: "auto_validated", MARK_CAPTURES_INCOMPLETE: "captures_incomplete", START_GENERATION: "generating" },
  generating: { GENERATION_SUCCEEDED: "generated", GENERATION_FAILED: "failed" },
  generated: { MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW: "ready_for_review", MARK_CAPTURES_INCOMPLETE: "captures_incomplete", AUTO_VALIDATE: "auto_validated" },
  failed: { RESET_TO_DRAFT: "draft", START_GENERATION: "generating", AUTO_VALIDATE: "auto_validated" },
};

// Shared with the extension (which does not depend on this package) so both enforce the same final-generation rule.
export { finalGenerationDataBlockers, type FinalGenerationBlocker, type FinalGenerationBlockerCode, type FinalGenerationClientProfile } from "@tention/report-schema";

export function applyReportEvent(draft: ReportDraft, event: ReportEvent, context: DomainContext): ReportDraft {
  const nextStatus = transitions[draft.status]?.[event];
  if (!nextStatus) throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", `Event ${event} is not allowed from ${draft.status}.`);
  const requiresCaptureReviewValidation = event === "SUBMIT_FOR_REVIEW" || event === "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW" || event === "AUTO_VALIDATE";
  const validation = requiresCaptureReviewValidation ? validateReportDraft(draft, context) : draft.validation;
  if (requiresCaptureReviewValidation && validation.errors.length > 0) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Report validation blocks review submission.", validation);
  }
  return { ...draft, status: nextStatus, validation, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
}

/**
 * Records backend machine validation on the listed automatic captures and moves the report to auto_validated. The
 * caller must already have re-verified each capture's stored bytes. Never sets `approved`: human approval stays a
 * separate fact. Throws (nothing changes) unless the whole report then validates with zero errors.
 */
export function applyAutomatedValidation(draft: ReportDraft, verifiedTypes: readonly ScreenshotType[], context: DomainContext): ReportDraft {
  const at = validInstant(context.now).toISOString();
  const verified = new Set(verifiedTypes);
  const screenshots = draft.screenshots.map((screenshot) => !screenshot.approved && screenshot.captureOrigin === "live_acceptance_import" && verified.has(screenshot.type)
    ? { ...screenshot, automatedValidatedAt: at } : screenshot);
  return applyReportEvent({ ...draft, screenshots }, "AUTO_VALIDATE", context);
}

export function upsertScreenshotMetadata(
  draft: ReportDraft, screenshot: ScreenshotRecord, routeType: ScreenshotType, context: DomainContext,
): ReportDraft {
  const next = withUpdatedScreenshotMetadata(draft, screenshot, routeType, context);
  return { ...next, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
}

/** Atomically replaces/attaches a set of screenshot metadata records with one optimistic version increment. */
export function upsertScreenshotMetadataBatch(
  draft: ReportDraft, screenshots: readonly ScreenshotRecord[], context: DomainContext,
): ReportDraft {
  const byType = new Map<ScreenshotType, ScreenshotRecord>();
  for (const screenshot of screenshots) {
    if (byType.has(screenshot.type)) throw new ReportDomainError("DUPLICATE_SCREENSHOT_TYPE", "A screenshot batch contains the same section more than once.");
    if (screenshot.clientId !== draft.client.id) throw new ReportDomainError("SCREENSHOT_CLIENT_MISMATCH", "Screenshot belongs to another client.");
    if (!sameMonth(screenshot.reportMonth, draft.reportMonth)) throw new ReportDomainError("SCREENSHOT_MONTH_MISMATCH", "Screenshot belongs to another report month.");
    byType.set(screenshot.type, screenshot);
  }
  if (!screenshots.length) return draft;
  const nextScreenshots = draft.screenshots.filter(({ type }) => !byType.has(type));
  for (const [type, screenshot] of byType) {
    if (screenshot.type !== type) throw new ReportDomainError("SCREENSHOT_TYPE_MISMATCH", "Route and payload screenshot types differ.");
    nextScreenshots.push(screenshot);
  }
  const next = { ...draft, screenshots: nextScreenshots, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
  return { ...next, validation: validateReportDraft(next, context) };
}

/** A replacement invalidates a completed capture review only for a required screenshot. */
export function replacementInvalidatesCaptureReview(draft: ReportDraft, routeType: ScreenshotType): boolean {
  return (draft.status === "ready_for_review" || draft.status === "generated" || draft.status === "auto_validated") && draft.sections[screenshotSectionMapping[routeType]] === "required";
}

export function replaceScreenshotAndInvalidateCaptureReview(
  draft: ReportDraft, screenshot: ScreenshotRecord, routeType: ScreenshotType, context: DomainContext,
): ReportDraft {
  if (!replacementInvalidatesCaptureReview(draft, routeType)) {
    throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "Screenshot replacement does not invalidate capture review for this report.");
  }
  return applyReportEvent(withUpdatedScreenshotMetadata(draft, screenshot, routeType, context), "MARK_CAPTURES_INCOMPLETE", context);
}

function withUpdatedScreenshotMetadata(
  draft: ReportDraft, screenshot: ScreenshotRecord, routeType: ScreenshotType, context: DomainContext,
): ReportDraft {
  if (screenshot.type !== routeType) throw new ReportDomainError("SCREENSHOT_TYPE_MISMATCH", "Route and payload screenshot types differ.");
  if (screenshot.clientId !== draft.client.id) throw new ReportDomainError("SCREENSHOT_CLIENT_MISMATCH", "Screenshot belongs to another client.");
  if (!sameMonth(screenshot.reportMonth, draft.reportMonth)) throw new ReportDomainError("SCREENSHOT_MONTH_MISMATCH", "Screenshot belongs to another report month.");
  const screenshots = [...draft.screenshots.filter(({ type }) => type !== routeType), screenshot];
  const next = { ...draft, screenshots };
  return { ...next, validation: validateReportDraft(next, context) };
}

export interface ReportDraftRepository {
  create(draft: ReportDraft): Promise<ReportDraft>;
  getById(id: string): Promise<ReportDraft | null>;
  save(draft: ReportDraft, expectedVersion: number): Promise<ReportDraft>;
  saveWithLifecycleEvent(draft: ReportDraft, expectedVersion: number, eventType: ReportEvent): Promise<ReportDraft>;
  delete(id: string, expectedVersion: number): Promise<ReportDraft>;
  list(): Promise<ReportDraft[]>;
  getHistory(reportId: string): Promise<ReportLifecycleEvent[]>;
  saveGeneratedArtifact(draft: ReportDraft, expectedVersion: number, artifact: ReportPdfArtifact): Promise<ReportDraft>;
  getArtifactForFingerprint(reportId: string, sourceFingerprint: string): Promise<ReportPdfArtifact | null>;
  listArtifacts(reportId: string): Promise<ReportPdfArtifact[]>;
  /** Records the Drive delivery outcome on an existing artifact; the artifact's canonical fields never change. */
  saveArtifactDriveDelivery(reportId: string, artifactId: string, delivery: ReportPdfDriveDelivery): Promise<ReportPdfArtifact>;
  /** Records the editable Google Doc copy outcome on an existing artifact; the artifact's canonical fields never change. */
  saveArtifactGoogleDoc(reportId: string, artifactId: string, googleDoc: ReportGoogleDoc): Promise<ReportPdfArtifact>;
  /** Local-development identity repair; implementations preserve draft history and artifacts. */
  rekeyLocalDraft(fromId: string, toId: string, expectedVersion: number): Promise<ReportDraft>;
}

/** Non-production repository for local API development and tests. */
export class InMemoryReportDraftRepository implements ReportDraftRepository {
  private readonly drafts = new Map<string, ReportDraft>();
  private readonly history = new Map<string, ReportLifecycleEvent[]>();
  private readonly artifacts = new Map<string, ReportPdfArtifact[]>();
  async create(draft: ReportDraft): Promise<ReportDraft> {
    const parsed = parseDraft(draft);
    if ([...this.drafts.values()].some((stored) => sameClientMonth(stored, parsed))) {
      throw new ReportPersistenceError("REPORT_DRAFT_ALREADY_EXISTS", "A report draft already exists for this client and month.");
    }
    this.drafts.set(parsed.id, structuredClone(parsed));
    this.history.set(parsed.id, [createHistoryEvent(parsed, "REPORT_CREATED", null, parsed.status)]);
    return structuredClone(parsed);
  }
  async getById(id: string): Promise<ReportDraft | null> { return structuredClone(this.drafts.get(id) ?? null); }
  async save(draft: ReportDraft, expectedVersion: number): Promise<ReportDraft> {
    return this.persist(draft, expectedVersion);
  }
  async saveWithLifecycleEvent(draft: ReportDraft, expectedVersion: number, eventType: ReportEvent): Promise<ReportDraft> {
    const current = this.requireCurrent(draft.id, expectedVersion);
    const saved = this.persist(draft, expectedVersion);
    const event = createHistoryEvent(saved, eventType, current.status, saved.status);
    this.history.set(draft.id, [...(this.history.get(draft.id) ?? []), event]);
    return saved;
  }
  async delete(id: string, expectedVersion: number): Promise<ReportDraft> {
    const current = this.requireCurrent(id, expectedVersion);
    this.history.delete(id);
    this.artifacts.delete(id);
    this.drafts.delete(id);
    return structuredClone(current);
  }
  async list(): Promise<ReportDraft[]> { return [...this.drafts.values()].map((draft) => structuredClone(draft)); }
  async getHistory(reportId: string): Promise<ReportLifecycleEvent[]> {
    if (!this.drafts.has(reportId)) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
    return structuredClone(this.history.get(reportId) ?? []);
  }
  async saveGeneratedArtifact(draft: ReportDraft, expectedVersion: number, artifact: ReportPdfArtifact): Promise<ReportDraft> {
    const current = this.requireCurrent(draft.id, expectedVersion);
    if (current.status !== "generating" || draft.status !== "generated" || artifact.reportId !== draft.id) {
      throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "A PDF artifact can only complete an active report generation.");
    }
    if (await this.getArtifactForFingerprint(draft.id, artifact.sourceFingerprint)) {
      throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "A PDF artifact already exists for this report source.");
    }
    const saved = this.persist(draft, expectedVersion);
    this.artifacts.set(draft.id, [...(this.artifacts.get(draft.id) ?? []), structuredClone(artifact)]);
    this.history.set(draft.id, [...(this.history.get(draft.id) ?? []), createHistoryEvent(saved, "GENERATION_SUCCEEDED", current.status, saved.status)]);
    return saved;
  }
  async getArtifactForFingerprint(reportId: string, sourceFingerprint: string): Promise<ReportPdfArtifact | null> {
    return structuredClone((this.artifacts.get(reportId) ?? []).find((artifact) => artifact.sourceFingerprint === sourceFingerprint) ?? null);
  }
  async listArtifacts(reportId: string): Promise<ReportPdfArtifact[]> { return structuredClone(this.artifacts.get(reportId) ?? []); }
  async saveArtifactDriveDelivery(reportId: string, artifactId: string, delivery: ReportPdfDriveDelivery): Promise<ReportPdfArtifact> {
    const artifact = (this.artifacts.get(reportId) ?? []).find(({ id }) => id === artifactId);
    if (!artifact) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "The PDF artifact does not exist for this report.");
    artifact.driveDelivery = structuredClone(delivery);
    return structuredClone(artifact);
  }
  async saveArtifactGoogleDoc(reportId: string, artifactId: string, googleDoc: ReportGoogleDoc): Promise<ReportPdfArtifact> {
    const artifact = (this.artifacts.get(reportId) ?? []).find(({ id }) => id === artifactId);
    if (!artifact) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "The PDF artifact does not exist for this report.");
    artifact.googleDoc = structuredClone(googleDoc);
    return structuredClone(artifact);
  }
  async rekeyLocalDraft(fromId: string, toId: string, expectedVersion: number): Promise<ReportDraft> {
    const current = this.requireCurrent(fromId, expectedVersion);
    if (this.drafts.has(toId)) throw new ReportPersistenceError("REPORT_DRAFT_ALREADY_EXISTS", "The target report ID is already assigned.");
    this.drafts.delete(fromId);
    const rekeyed = parseDraft({ ...current, id: toId });
    this.drafts.set(toId, structuredClone(rekeyed));
    this.history.set(toId, (this.history.get(fromId) ?? []).map((event) => ({ ...event, reportId: toId })));
    this.history.delete(fromId);
    this.artifacts.set(toId, (this.artifacts.get(fromId) ?? []).map((artifact) => ({ ...artifact, reportId: toId })));
    this.artifacts.delete(fromId);
    return structuredClone(rekeyed);
  }
  private persist(draft: ReportDraft, expectedVersion: number): ReportDraft {
    const current = this.requireCurrent(draft.id, expectedVersion);
    if (!sameIdentity(current, draft) || current.createdAt !== draft.createdAt) {
      throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Immutable report identity cannot be changed.");
    }
    if (draft.version !== expectedVersion + 1) {
      throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Saved report version must increment exactly once.");
    }
    const parsed = parseDraft(draft);
    this.drafts.set(parsed.id, structuredClone(parsed));
    return structuredClone(parsed);
  }
  private requireCurrent(id: string, expectedVersion: number): ReportDraft {
    const current = this.drafts.get(id);
    if (!current) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
    if (current.version !== expectedVersion) {
      throw new ReportPersistenceError("REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.", { expectedVersion, currentVersion: current.version });
    }
    return current;
  }
}

function sameMonth(left: ReportMonth, right: ReportMonth): boolean { return left.year === right.year && left.month === right.month; }
function hasStoredApprovedAsset(screenshot: ScreenshotRecord): boolean {
  return isAcceptedCapture(screenshot) && screenshot.periodConfirmed && screenshot.storageKey !== null &&
    screenshot.mimeType === "image/png" && screenshot.byteSize !== null && screenshot.sha256 !== null &&
    (screenshot.approved ? screenshot.approvedAt !== null : Boolean(screenshot.automatedValidatedAt)) && screenshot.width > 0 && screenshot.height > 0;
}
function validInstant(value: Date): Date {
  if (Number.isNaN(value.getTime())) throw new Error("now must be a valid Date");
  return value;
}

function parseDraft(value: ReportDraft): ReportDraft {
  const result = reportDraftSchema.safeParse(value);
  if (!result.success) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Report draft failed schema validation.");
  return result.data;
}

function sameIdentity(left: ReportDraft, right: ReportDraft): boolean {
  return left.id === right.id && left.client.id === right.client.id &&
    left.reportMonth.year === right.reportMonth.year && left.reportMonth.month === right.reportMonth.month;
}

function sameClientMonth(left: ReportDraft, right: ReportDraft): boolean {
  return left.client.id === right.client.id && left.reportMonth.year === right.reportMonth.year &&
    left.reportMonth.month === right.reportMonth.month;
}

function createHistoryEvent(
  draft: ReportDraft, eventType: ReportLifecycleEvent["eventType"],
  fromStatus: ReportStatus | null, toStatus: ReportStatus,
): ReportLifecycleEvent {
  return reportLifecycleEventSchema.parse({
    id: crypto.randomUUID(), reportId: draft.id, eventType, fromStatus, toStatus,
    reportVersion: draft.version, createdAt: draft.updatedAt, metadata: null,
  });
}
