import { getReportPeriod, isCompletedMonthAtInstant } from "@tention/report-core";
import {
  isValidIanaTimeZone, reportSectionKeySchema, screenshotSectionMapping,
  type ClientSummary, type ReportDraft, type ReportMonth, type ReportSectionKey,
  type ReportStatus, type ReportValidationIssue, type ReportValidationState,
  reportDraftSchema, reportLifecycleEventSchema, type ReportLifecycleEvent,
  type ScreenshotRecord, type ScreenshotType, type SectionConfiguration,
} from "@tention/report-schema";

export type ValidationIssueCode =
  | "REPORT_MONTH_INCOMPLETE" | "INVALID_CLIENT_TIMEZONE" | "REPORT_PERIOD_MISMATCH"
  | "SCREENSHOT_CLIENT_MISMATCH" | "SCREENSHOT_MONTH_MISMATCH" | "SCREENSHOT_TYPE_MISMATCH"
  | "REQUIRED_SCREENSHOT_MISSING" | "REQUIRED_SCREENSHOT_UNAPPROVED"
  | "REQUIRED_SCREENSHOT_PERIOD_UNCONFIRMED" | "REQUIRED_SCREENSHOT_ASSET_MISSING"
  | "DUPLICATE_SCREENSHOT_TYPE" | "DISABLED_SECTION_SCREENSHOT_PRESENT"
  | "UNKNOWN_SECTION_CONFIGURATION";

export type ReportEvent =
  | "START_DATA_FETCH" | "DATA_FETCH_SUCCEEDED" | "DATA_FETCH_FAILED"
  | "MARK_CAPTURES_INCOMPLETE" | "SUBMIT_FOR_REVIEW" | "APPROVE"
  | "START_GENERATION" | "GENERATION_SUCCEEDED" | "GENERATION_FAILED" | "RESET_TO_DRAFT";

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
    if (draft.sections[section] === "disabled") issue("DISABLED_SECTION_SCREENSHOT_PRESENT", "warning", "A disabled section has screenshot metadata.", { section, screenshotType: screenshot.type });
  }

  for (const [type, screenshots] of byType) {
    if (screenshots.length > 1) issue("DUPLICATE_SCREENSHOT_TYPE", "error", "More than one screenshot exists for the same type.", { screenshotType: type });
  }

  for (const [type, section] of Object.entries(screenshotSectionMapping) as [ScreenshotType, ReportSectionKey][]) {
    if (draft.sections[section] !== "required") continue;
    const candidates = (byType.get(type) ?? []).filter((screenshot) =>
      screenshot.clientId === draft.client.id && sameMonth(screenshot.reportMonth, draft.reportMonth));
    if (candidates.length === 0) {
      issue("REQUIRED_SCREENSHOT_MISSING", "error", "A required section is missing screenshot metadata.", { section, screenshotType: type });
    } else if (!candidates.some(({ approved }) => approved)) {
      issue("REQUIRED_SCREENSHOT_UNAPPROVED", "error", "A required screenshot has not been approved.", { section, screenshotType: type });
    } else if (!candidates.some(({ approved, periodConfirmed }) => approved && periodConfirmed)) {
      issue("REQUIRED_SCREENSHOT_PERIOD_UNCONFIRMED", "error", "A required screenshot needs human report-period confirmation.", { section, screenshotType: type });
    } else if (!candidates.some(hasStoredApprovedAsset)) {
      issue("REQUIRED_SCREENSHOT_ASSET_MISSING", "error", "A required screenshot is missing its stored PNG asset metadata.", { section, screenshotType: type });
    }
  }
  return { status: errors.length === 0 ? "valid" : "invalid", errors, warnings };
}

const transitions: Partial<Record<ReportStatus, Partial<Record<ReportEvent, ReportStatus>>>> = {
  draft: { START_DATA_FETCH: "data_fetching" },
  data_fetching: { DATA_FETCH_SUCCEEDED: "data_ready", DATA_FETCH_FAILED: "failed" },
  data_ready: { MARK_CAPTURES_INCOMPLETE: "captures_incomplete", SUBMIT_FOR_REVIEW: "ready_for_review" },
  captures_incomplete: { SUBMIT_FOR_REVIEW: "ready_for_review" },
  ready_for_review: { APPROVE: "approved" },
  approved: { START_GENERATION: "generating" },
  generating: { GENERATION_SUCCEEDED: "generated", GENERATION_FAILED: "failed" },
  failed: { RESET_TO_DRAFT: "draft" },
};

export function applyReportEvent(draft: ReportDraft, event: ReportEvent, context: DomainContext): ReportDraft {
  const nextStatus = transitions[draft.status]?.[event];
  if (!nextStatus) throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", `Event ${event} is not allowed from ${draft.status}.`);
  const validation = event === "SUBMIT_FOR_REVIEW" ? validateReportDraft(draft, context) : draft.validation;
  if (event === "SUBMIT_FOR_REVIEW" && validation.errors.length > 0) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Report validation blocks review submission.", validation);
  }
  return { ...draft, status: nextStatus, validation, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
}

export function upsertScreenshotMetadata(
  draft: ReportDraft, screenshot: ScreenshotRecord, routeType: ScreenshotType, context: DomainContext,
): ReportDraft {
  if (screenshot.type !== routeType) throw new ReportDomainError("SCREENSHOT_TYPE_MISMATCH", "Route and payload screenshot types differ.");
  if (screenshot.clientId !== draft.client.id) throw new ReportDomainError("SCREENSHOT_CLIENT_MISMATCH", "Screenshot belongs to another client.");
  if (!sameMonth(screenshot.reportMonth, draft.reportMonth)) throw new ReportDomainError("SCREENSHOT_MONTH_MISMATCH", "Screenshot belongs to another report month.");
  const screenshots = [...draft.screenshots.filter(({ type }) => type !== routeType), screenshot];
  const next = { ...draft, screenshots, version: draft.version + 1, updatedAt: validInstant(context.now).toISOString() };
  return { ...next, validation: validateReportDraft(next, context) };
}

export interface ReportDraftRepository {
  create(draft: ReportDraft): Promise<ReportDraft>;
  getById(id: string): Promise<ReportDraft | null>;
  save(draft: ReportDraft, expectedVersion: number): Promise<ReportDraft>;
  saveWithLifecycleEvent(draft: ReportDraft, expectedVersion: number, eventType: ReportEvent): Promise<ReportDraft>;
  list(): Promise<ReportDraft[]>;
  getHistory(reportId: string): Promise<ReportLifecycleEvent[]>;
}

export type PersistenceErrorCode =
  | "REPORT_NOT_FOUND" | "REPORT_VERSION_CONFLICT" | "REPORT_DRAFT_ALREADY_EXISTS"
  | "PERSISTENCE_DATA_INVALID" | "DATABASE_UNAVAILABLE";

export class ReportPersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
    public readonly details?: { expectedVersion?: number; currentVersion?: number },
  ) { super(message); this.name = "ReportPersistenceError"; }
}

/** Non-production repository for local API development and tests. */
export class InMemoryReportDraftRepository implements ReportDraftRepository {
  private readonly drafts = new Map<string, ReportDraft>();
  private readonly history = new Map<string, ReportLifecycleEvent[]>();
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
  async list(): Promise<ReportDraft[]> { return [...this.drafts.values()].map((draft) => structuredClone(draft)); }
  async getHistory(reportId: string): Promise<ReportLifecycleEvent[]> {
    if (!this.drafts.has(reportId)) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
    return structuredClone(this.history.get(reportId) ?? []);
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
  return screenshot.approved && screenshot.periodConfirmed && screenshot.storageKey !== null &&
    screenshot.mimeType === "image/png" && screenshot.byteSize !== null && screenshot.sha256 !== null &&
    screenshot.approvedAt !== null && screenshot.width > 0 && screenshot.height > 0;
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
