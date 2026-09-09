import { InMemoryReportDraftRepository, ReportPersistenceError, type ReportDraftRepository } from "@tention/report-domain";
import { createPostgresPool } from "./pool.js";
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
