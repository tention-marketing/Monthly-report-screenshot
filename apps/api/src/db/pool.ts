import { Pool } from "pg";
import { ReportPersistenceError } from "@tention/report-domain";

export function createPostgresPool(databaseUrl: string | undefined): Pool {
  if (!databaseUrl) {
    throw new ReportPersistenceError("DATABASE_UNAVAILABLE", "DATABASE_URL is required for PostgreSQL storage.");
  }
  return new Pool({ connectionString: databaseUrl });
}
