import { randomUUID } from "node:crypto";
import { types, type Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  ReportPersistenceError, type ReportDraftRepository, type ReportEvent,
} from "@tention/report-domain";
import {
  reportDraftSchema, reportLifecycleEventSchema, reportPdfArtifactSchema, type ReportDraft, type ReportLifecycleEvent, type ReportPdfArtifact, type ReportPdfDriveDelivery, reportPdfDriveDeliverySchema, type ReportGoogleDoc, reportGoogleDocSchema,
} from "@tention/report-schema";

// PostgreSQL DATE is a business calendar date, so never parse it through the machine timezone.
types.setTypeParser(1082, (value) => value);

interface DraftRow extends QueryResultRow {
  id: string; client_id: string; client_name: string; client_timezone: string; client_currency: string | null;
  report_year: number; report_month: number; period_start: string | Date; period_end: string | Date;
  previous_period_start: string | Date; previous_period_end: string | Date; status: ReportDraft["status"];
  sections: unknown; screenshots: unknown; validation: unknown; version: number;
  created_at: string | Date; updated_at: string | Date;
  /** Report-time conversion metric + Klaviyo account; NULL on reports created before client onboarding. */
  client_setup_snapshot?: unknown;
}

interface HistoryRow extends QueryResultRow {
  id: string; report_id: string; event_type: ReportLifecycleEvent["eventType"];
  from_status: ReportLifecycleEvent["fromStatus"]; to_status: ReportLifecycleEvent["toStatus"];
  report_version: number; created_at: string | Date; metadata: unknown;
}
interface ArtifactRow extends QueryResultRow {
  id: string; report_id: string; storage_key: string; mime_type: string; byte_size: number;
  sha256: string; source_fingerprint: string; template_version: string; generated_at: string | Date; drive_delivery?: unknown; google_doc?: unknown;
}

export class PostgresReportDraftRepository implements ReportDraftRepository {
  constructor(private readonly pool: Pool) {}

  async create(draft: ReportDraft): Promise<ReportDraft> {
    return this.withErrors(async () => {
      const parsed = reportDraftSchema.parse(draft);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<DraftRow>(`
          INSERT INTO report_drafts (
            id, client_id, client_name, client_timezone, client_currency, report_year, report_month,
            period_start, period_end, previous_period_start, previous_period_end, status, sections,
            screenshots, validation, version, created_at, updated_at, client_setup_snapshot
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
          ) RETURNING *
        `, draftValues(parsed));
        const stored = parseDraftRow(requireRow(result.rows[0]));
        await insertHistory(client, {
          id: randomUUID(), reportId: stored.id, eventType: "REPORT_CREATED", fromStatus: null,
          toStatus: "draft", reportVersion: stored.version, createdAt: stored.createdAt, metadata: null,
        });
        await client.query("COMMIT");
        return stored;
      } catch (error) {
        await client.query("ROLLBACK");
        if (isPgCode(error, "23505")) {
          throw new ReportPersistenceError("REPORT_DRAFT_ALREADY_EXISTS", "A report draft already exists for this client and month.");
        }
        throw error;
      } finally { client.release(); }
    });
  }

  async getById(id: string): Promise<ReportDraft | null> {
    return this.withErrors(async () => {
      const result = await this.pool.query<DraftRow>("SELECT * FROM report_drafts WHERE id = $1", [id]);
      return result.rows[0] ? parseDraftRow(result.rows[0]) : null;
    });
  }

  async save(draft: ReportDraft, expectedVersion: number): Promise<ReportDraft> {
    return this.withErrors(() => updateDraft(this.pool, draft, expectedVersion));
  }

  async saveWithLifecycleEvent(draft: ReportDraft, expectedVersion: number, eventType: ReportEvent): Promise<ReportDraft> {
    return this.withErrors(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const before = await currentDraft(client, draft.id);
        const stored = await updateDraft(client, draft, expectedVersion);
        await insertHistory(client, {
          id: randomUUID(), reportId: stored.id, eventType, fromStatus: before.status,
          toStatus: stored.status, reportVersion: stored.version, createdAt: stored.updatedAt, metadata: null,
        });
        await client.query("COMMIT");
        return stored;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    });
  }

  async delete(id: string, expectedVersion: number): Promise<ReportDraft> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const current = await currentDraft(client, id, true);
        if (current.version !== expectedVersion) {
          throw new ReportPersistenceError(
            "REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.",
            { expectedVersion, currentVersion: current.version },
          );
        }
        await client.query("DELETE FROM report_lifecycle_events WHERE report_id = $1", [id]);
        await client.query("DELETE FROM report_drafts WHERE id = $1 AND version = $2", [id, expectedVersion]);
        await client.query("COMMIT");
        return current;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    } catch (error) {
      if (error instanceof ReportPersistenceError) throw error;
      throw new ReportPersistenceError("REPORT_DELETE_FAILED", "Report draft could not be deleted.");
    }
  }

  async list(): Promise<ReportDraft[]> {
    return this.withErrors(async () => {
      const result = await this.pool.query<DraftRow>("SELECT * FROM report_drafts ORDER BY created_at ASC, id ASC");
      return result.rows.map(parseDraftRow);
    });
  }

  async getHistory(reportId: string): Promise<ReportLifecycleEvent[]> {
    return this.withErrors(async () => {
      if (!(await this.getById(reportId))) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
      const result = await this.pool.query<HistoryRow>(`
        SELECT * FROM report_lifecycle_events
        WHERE report_id = $1
        ORDER BY created_at ASC, report_version ASC, id ASC
      `, [reportId]);
      return result.rows.map(parseHistoryRow);
    });
  }

  async saveGeneratedArtifact(draft: ReportDraft, expectedVersion: number, artifact: ReportPdfArtifact): Promise<ReportDraft> {
    return this.withErrors(async () => {
      const parsedArtifact = reportPdfArtifactSchema.parse(artifact);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const before = await currentDraft(client, draft.id, true);
        if (before.status !== "generating" || draft.status !== "generated" || parsedArtifact.reportId !== draft.id) {
          throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "A PDF artifact can only complete an active report generation.");
        }
        const stored = await updateDraft(client, draft, expectedVersion);
        await client.query(`INSERT INTO report_pdf_artifacts (
          id, report_id, storage_key, mime_type, byte_size, sha256, source_fingerprint, template_version, generated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, artifactValues(parsedArtifact));
        await insertHistory(client, {
          id: randomUUID(), reportId: stored.id, eventType: "GENERATION_SUCCEEDED", fromStatus: before.status,
          toStatus: stored.status, reportVersion: stored.version, createdAt: stored.updatedAt, metadata: { artifactId: parsedArtifact.id },
        });
        await client.query("COMMIT");
        return stored;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    });
  }

  async getArtifactForFingerprint(reportId: string, sourceFingerprint: string): Promise<ReportPdfArtifact | null> {
    return this.withErrors(async () => {
      const result = await this.pool.query<ArtifactRow>(`SELECT * FROM report_pdf_artifacts
        WHERE report_id = $1 AND source_fingerprint = $2`, [reportId, sourceFingerprint]);
      return result.rows[0] ? parseArtifactRow(result.rows[0]) : null;
    });
  }

  async listArtifacts(reportId: string): Promise<ReportPdfArtifact[]> {
    return this.withErrors(async () => {
      const result = await this.pool.query<ArtifactRow>(`SELECT * FROM report_pdf_artifacts
        WHERE report_id = $1 ORDER BY generated_at DESC, id DESC`, [reportId]);
      return result.rows.map(parseArtifactRow);
    });
  }

  async saveArtifactDriveDelivery(reportId: string, artifactId: string, delivery: ReportPdfDriveDelivery): Promise<ReportPdfArtifact> {
    return this.withErrors(async () => {
      const parsed = reportPdfDriveDeliverySchema.parse(delivery);
      const result = await this.pool.query<ArtifactRow>(`UPDATE report_pdf_artifacts SET drive_delivery = $3::jsonb
        WHERE report_id = $1 AND id = $2 RETURNING *`, [reportId, artifactId, JSON.stringify(parsed)]);
      if (!result.rows[0]) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "The PDF artifact does not exist for this report.");
      return parseArtifactRow(result.rows[0]);
    });
  }

  async saveArtifactGoogleDoc(reportId: string, artifactId: string, googleDoc: ReportGoogleDoc): Promise<ReportPdfArtifact> {
    return this.withErrors(async () => {
      const parsed = reportGoogleDocSchema.parse(googleDoc);
      const result = await this.pool.query<ArtifactRow>(`UPDATE report_pdf_artifacts SET google_doc = $3::jsonb
        WHERE report_id = $1 AND id = $2 RETURNING *`, [reportId, artifactId, JSON.stringify(parsed)]);
      if (!result.rows[0]) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "The PDF artifact does not exist for this report.");
      return parseArtifactRow(result.rows[0]);
    });
  }

  async rekeyLocalDraft(fromId: string, toId: string, expectedVersion: number): Promise<ReportDraft> {
    return this.withErrors(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const current = await currentDraft(client, fromId, true);
        if (current.version !== expectedVersion) {
          throw new ReportPersistenceError("REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.", { expectedVersion, currentVersion: current.version });
        }
        const target = await client.query("SELECT id FROM report_drafts WHERE id = $1", [toId]);
        if (target.rowCount) throw new ReportPersistenceError("REPORT_DRAFT_ALREADY_EXISTS", "The target report ID is already assigned.");
        if (current.status !== "draft") throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Only a local development draft can have its identity repaired.");

        // Foreign keys are immediate in the production schema. Move referencing rows out,
        // update the draft PK, then restore them under the new PK within this transaction.
        const events = await client.query<HistoryRow>("DELETE FROM report_lifecycle_events WHERE report_id = $1 RETURNING *", [fromId]);
        const artifacts = await client.query<ArtifactRow>("DELETE FROM report_pdf_artifacts WHERE report_id = $1 RETURNING *", [fromId]);
        const updated = await client.query<DraftRow>("UPDATE report_drafts SET id = $2 WHERE id = $1 AND version = $3 RETURNING *", [fromId, toId, expectedVersion]);
        if (!updated.rows[0]) throw new ReportPersistenceError("REPORT_VERSION_CONFLICT", "Report draft changed during identity repair.");
        for (const row of events.rows) await client.query(`INSERT INTO report_lifecycle_events (id, report_id, event_type, from_status, to_status, report_version, created_at, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, toId, row.event_type, row.from_status, row.to_status, row.report_version, row.created_at, row.metadata]);
        for (const row of artifacts.rows) await client.query(`INSERT INTO report_pdf_artifacts (id, report_id, storage_key, mime_type, byte_size, sha256, source_fingerprint, template_version, generated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.id, toId, row.storage_key, row.mime_type, row.byte_size, row.sha256, row.source_fingerprint, row.template_version, row.generated_at]);
        await client.query("COMMIT");
        return parseDraftRow(updated.rows[0]);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    });
  }

  private async withErrors<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ReportPersistenceError) throw error;
      if (error instanceof Error && error.name === "ZodError") {
        throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Persisted report data failed schema validation.");
      }
      throw new ReportPersistenceError("DATABASE_UNAVAILABLE", "PostgreSQL persistence operation failed.");
    }
  }
}

type Queryable = Pick<Pool | PoolClient, "query">;

async function updateDraft(db: Queryable, draft: ReportDraft, expectedVersion: number): Promise<ReportDraft> {
  if (draft.version !== expectedVersion + 1) {
    throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Saved report version must increment exactly once.");
  }
  const result = await db.query<DraftRow>(`
    UPDATE report_drafts SET
      client_name = $2, client_timezone = $3, client_currency = $4,
      period_start = $5, period_end = $6, previous_period_start = $7, previous_period_end = $8,
      status = $9, sections = $10, screenshots = $11, validation = $12,
      version = version + 1, updated_at = $13
    WHERE id = $1 AND version = $14
      AND client_id = $15 AND report_year = $16 AND report_month = $17 AND created_at = $18
    RETURNING *
  `, [
    draft.id, draft.client.name, draft.client.timezone, draft.client.currency,
    draft.period.startDate, draft.period.endDate, draft.period.previousStartDate, draft.period.previousEndDate,
    draft.status, JSON.stringify(draft.sections), JSON.stringify(draft.screenshots), JSON.stringify(draft.validation), draft.updatedAt, expectedVersion,
    draft.client.id, draft.reportMonth.year, draft.reportMonth.month, draft.createdAt,
  ]);
  if (result.rows[0]) return parseDraftRow(result.rows[0]);
  const current = await db.query<DraftRow>("SELECT * FROM report_drafts WHERE id = $1", [draft.id]);
  if (!current.rows[0]) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
  const stored = parseDraftRow(current.rows[0]);
  if (stored.version !== expectedVersion) {
    throw new ReportPersistenceError("REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.", { expectedVersion, currentVersion: stored.version });
  }
  throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Immutable report identity cannot be changed.");
}

async function currentDraft(db: Queryable, id: string, lock = false): Promise<ReportDraft> {
  const result = await db.query<DraftRow>(`SELECT * FROM report_drafts WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!result.rows[0]) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
  return parseDraftRow(result.rows[0]);
}

async function insertHistory(client: PoolClient, event: ReportLifecycleEvent): Promise<void> {
  const parsed = reportLifecycleEventSchema.parse(event);
  await client.query(`
    INSERT INTO report_lifecycle_events (
      id, report_id, event_type, from_status, to_status, report_version, created_at, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    parsed.id, parsed.reportId, parsed.eventType, parsed.fromStatus, parsed.toStatus,
    parsed.reportVersion, parsed.createdAt, parsed.metadata === null ? null : JSON.stringify(parsed.metadata),
  ]);
}

function draftValues(draft: ReportDraft): unknown[] {
  return [
    draft.id, draft.client.id, draft.client.name, draft.client.timezone, draft.client.currency,
    draft.reportMonth.year, draft.reportMonth.month, draft.period.startDate, draft.period.endDate,
    draft.period.previousStartDate, draft.period.previousEndDate, draft.status, JSON.stringify(draft.sections),
    JSON.stringify(draft.screenshots), JSON.stringify(draft.validation), draft.version, draft.createdAt, draft.updatedAt,
    draft.client.conversionMetric || draft.client.klaviyoAccount ? JSON.stringify({ conversionMetric: draft.client.conversionMetric ?? null, klaviyoAccount: draft.client.klaviyoAccount ?? null }) : null,
  ];
}

function parseDraftRow(row: DraftRow): ReportDraft {
  const result = reportDraftSchema.safeParse({
    id: row.id, client: { id: row.client_id, name: row.client_name, timezone: row.client_timezone, currency: row.client_currency?.trim() ?? null, ...clientSnapshot(row.client_setup_snapshot) },
    reportMonth: { year: row.report_year, month: row.report_month },
    period: { startDate: calendarDate(row.period_start), endDate: calendarDate(row.period_end), previousStartDate: calendarDate(row.previous_period_start), previousEndDate: calendarDate(row.previous_period_end) },
    status: row.status, sections: row.sections, screenshots: row.screenshots, validation: row.validation,
    version: row.version, createdAt: instant(row.created_at), updatedAt: instant(row.updated_at),
  });
  if (!result.success) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", `Persisted report data failed schema validation: ${result.error.message}`);
  return result.data;
}

/** The written-once report-time snapshot; reports created before onboarding have none and carry no snapshot keys. */
function clientSnapshot(value: unknown): Pick<ReportDraft["client"], "conversionMetric" | "klaviyoAccount"> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Persisted client setup snapshot is invalid.");
  const snapshot = value as { conversionMetric?: unknown; klaviyoAccount?: unknown };
  return { conversionMetric: (snapshot.conversionMetric ?? null) as never, klaviyoAccount: (snapshot.klaviyoAccount ?? null) as never };
}

function parseHistoryRow(row: HistoryRow): ReportLifecycleEvent {
  const result = reportLifecycleEventSchema.safeParse({
    id: row.id, reportId: row.report_id, eventType: row.event_type, fromStatus: row.from_status,
    toStatus: row.to_status, reportVersion: row.report_version, createdAt: instant(row.created_at), metadata: row.metadata,
  });
  if (!result.success) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", `Persisted lifecycle history failed schema validation: ${result.error.message}`);
  return result.data;
}
function parseArtifactRow(row: ArtifactRow): ReportPdfArtifact {
  const result = reportPdfArtifactSchema.safeParse({
    id: row.id, reportId: row.report_id, storageKey: row.storage_key, mimeType: row.mime_type,
    byteSize: row.byte_size, sha256: row.sha256.trim(), sourceFingerprint: row.source_fingerprint.trim(),
    templateVersion: row.template_version, generatedAt: instant(row.generated_at),
    ...(row.drive_delivery ? { driveDelivery: row.drive_delivery } : {}),
    ...(row.google_doc ? { googleDoc: row.google_doc } : {}),
  });
  if (!result.success) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Persisted PDF artifact failed schema validation.");
  return result.data;
}
function artifactValues(artifact: ReportPdfArtifact): unknown[] {
  return [artifact.id, artifact.reportId, artifact.storageKey, artifact.mimeType, artifact.byteSize,
    artifact.sha256, artifact.sourceFingerprint, artifact.templateVersion, artifact.generatedAt];
}

function calendarDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
function instant(value: string | Date): string { return typeof value === "string" ? new Date(value).toISOString() : value.toISOString(); }
function requireRow<T>(row: T | undefined): T { if (!row) throw new Error("Expected PostgreSQL to return a row."); return row; }
function isPgCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
