import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, ReportPersistenceError, type ClientReportTargetsRepository, type ReportDraftRepository } from "@tention/report-domain";
import { createPostgresPool } from "./pool.js";
import { PostgresClientReportTargetsRepository } from "./postgres-client-report-targets-repository.js";
import { PostgresReportDraftRepository } from "./postgres-report-draft-repository.js";

export interface StorageConfiguration {
  DATABASE_URL?: string;
  REPORT_STORAGE_MODE?: string;
}

export function createConfiguredRepository(environment: StorageConfiguration): ReportDraftRepository {
  if (environment.DATABASE_URL) {
    return new PostgresReportDraftRepository(createPostgresPool(environment.DATABASE_URL));
  }
  if (environment.REPORT_STORAGE_MODE === "memory") return new InMemoryReportDraftRepository();
  throw new ReportPersistenceError(
    "DATABASE_UNAVAILABLE",
    "DATABASE_URL is required. Set REPORT_STORAGE_MODE=memory only for explicit non-production use.",
  );
}

export function createConfiguredClientReportTargetsRepository(environment: StorageConfiguration): ClientReportTargetsRepository {
  if (environment.DATABASE_URL) return new PostgresClientReportTargetsRepository(createPostgresPool(environment.DATABASE_URL));
  if (environment.REPORT_STORAGE_MODE === "memory") return new InMemoryClientReportTargetsRepository();
  throw new ReportPersistenceError(
    "DATABASE_UNAVAILABLE",
    "DATABASE_URL is required. Set REPORT_STORAGE_MODE=memory only for explicit non-production use.",
  );
}
