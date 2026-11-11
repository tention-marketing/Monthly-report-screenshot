export type PersistenceErrorCode =
  | "REPORT_NOT_FOUND" | "REPORT_VERSION_CONFLICT" | "REPORT_DRAFT_ALREADY_EXISTS"
  | "REPORT_DELETE_FAILED" | "PERSISTENCE_DATA_INVALID" | "DATABASE_UNAVAILABLE"
  | "CLIENT_ACCOUNT_BINDING_IMMUTABLE" | "CLIENT_ACCOUNT_ALREADY_BOUND" | "CONVERSION_METRIC_ID_ALREADY_BOUND";

export class ReportPersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
    public readonly details?: { expectedVersion?: number; currentVersion?: number },
  ) { super(message); this.name = "ReportPersistenceError"; }
}
