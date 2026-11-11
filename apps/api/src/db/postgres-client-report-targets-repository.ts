import { type Pool, type QueryResultRow } from "pg";
import {
  conversionMetricAlreadyBound, emptyClientReportTargets, normalizeClientReportTargets, ReportPersistenceError,
  type ClientReportTargetsRepository,
} from "@tention/report-domain";
import { clientReportTargetsSchema, sameKlaviyoAccountIdentity, type ClientReportTargets, type ClientReportTargetsInput } from "@tention/report-schema";

interface TargetRow extends QueryResultRow { client_id: string; targets: unknown; created_at: string | Date; updated_at: string | Date }

export class PostgresClientReportTargetsRepository implements ClientReportTargetsRepository {
  constructor(private readonly pool: Pool) {}

  async get(clientId: string): Promise<ClientReportTargets> {
    try {
      const result = await this.pool.query<TargetRow>("SELECT * FROM client_report_targets WHERE client_id = $1", [clientId]);
      return result.rows[0] ? parseTargetRow(result.rows[0]) : emptyClientReportTargets(clientId);
    } catch (error) { throw persistenceError(error); }
  }

  async list(): Promise<ClientReportTargets[]> {
    try {
      const result = await this.pool.query<TargetRow>("SELECT * FROM client_report_targets ORDER BY client_id");
      return result.rows.map(parseTargetRow);
    } catch (error) { throw persistenceError(error); }
  }

  async save(clientId: string, input: ClientReportTargetsInput, now: Date): Promise<ClientReportTargets> {
    try {
      const targets = normalizeClientReportTargets(input);
      const existing = await this.get(clientId);
      if (existing.businessReview?.providerAccountId && existing.businessReview.providerAccountId !== targets.businessReview?.providerAccountId) {
        throw new ReportPersistenceError("CLIENT_ACCOUNT_BINDING_IMMUTABLE", "The saved Klaviyo account binding cannot be changed implicitly.");
      }
      const labelCorrection = Boolean(existing.businessReview?.accountLabel && existing.businessReview.accountLabel !== targets.businessReview?.accountLabel && sameKlaviyoAccountIdentity(existing.businessReview.accountLabel, targets.businessReview?.accountLabel));
      if (!existing.businessReview?.providerAccountId && existing.businessReview?.accountLabel && existing.businessReview.accountLabel !== targets.businessReview?.accountLabel && !labelCorrection) {
        throw new ReportPersistenceError("CLIENT_ACCOUNT_BINDING_IMMUTABLE", "The saved Klaviyo account binding cannot be changed implicitly.");
      }
      const metricId = targets.profile?.conversionMetric.providerMetricId?.trim();
      if (metricId) {
        const taken = await this.pool.query<{ client_id: string }>("SELECT client_id FROM client_report_targets WHERE targets #>> '{profile,conversionMetric,providerMetricId}' = $1 AND client_id <> $2 LIMIT 1", [metricId, clientId]);
        if (taken.rows[0]) throw conversionMetricAlreadyBound();
      }
      const result = await this.pool.query<TargetRow>(`
        INSERT INTO client_report_targets (client_id, targets, created_at, updated_at)
        VALUES ($1, $2::jsonb, $3, $3)
        ON CONFLICT (client_id) DO UPDATE SET targets = EXCLUDED.targets, updated_at = EXCLUDED.updated_at
        WHERE (client_report_targets.targets #>> '{businessReview,providerAccountId}' IS NULL
          OR client_report_targets.targets #>> '{businessReview,providerAccountId}' = EXCLUDED.targets #>> '{businessReview,providerAccountId}')
          AND (client_report_targets.targets #>> '{businessReview,providerAccountId}' IS NOT NULL
            OR client_report_targets.targets #>> '{businessReview,accountLabel}' IS NULL
          OR client_report_targets.targets #>> '{businessReview,accountLabel}' = EXCLUDED.targets #>> '{businessReview,accountLabel}'
          OR client_report_targets.targets #>> '{businessReview,accountLabel}' = $4)
        RETURNING *
      `, [clientId, JSON.stringify(targets), now.toISOString(), labelCorrection ? existing.businessReview!.accountLabel! : null]);
      if (!result.rows[0]) throw new ReportPersistenceError("CLIENT_ACCOUNT_BINDING_IMMUTABLE", "The saved Klaviyo account binding cannot be changed implicitly.");
      return parseTargetRow(result.rows[0]);
    } catch (error) { throw persistenceError(error); }
  }
}

function parseTargetRow(row: TargetRow): ClientReportTargets {
  const targets = typeof row.targets === "object" && row.targets !== null && !Array.isArray(row.targets) ? row.targets : {};
  const parsed = clientReportTargetsSchema.safeParse({
    clientId: row.client_id, ...targets,
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at),
  });
  if (!parsed.success) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Persisted client report targets failed schema validation.");
  return parsed.data;
}
function instant(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Persisted client report target timestamp is invalid.");
  return date.toISOString();
}
function persistenceError(error: unknown): ReportPersistenceError {
  if (error instanceof ReportPersistenceError) return error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505" && "constraint" in error && error.constraint === "client_report_targets_conversion_metric_uidx") return conversionMetricAlreadyBound();
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return new ReportPersistenceError("CLIENT_ACCOUNT_ALREADY_BOUND", "This Klaviyo account is already bound to another client.");
  if (error instanceof Error && error.name === "ZodError") return new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Client report targets are invalid.");
  return new ReportPersistenceError("DATABASE_UNAVAILABLE", "Client report target storage is unavailable.");
}
