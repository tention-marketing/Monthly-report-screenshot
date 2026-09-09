import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createPostgresPool } from "./pool.js";

export async function runMigrations(pool: Pool, directory = fileURLToPath(new URL("migrations", import.meta.url))): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const exists = await pool.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(`${directory}/${file}`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPostgresPool(process.env.DATABASE_URL);
  try {
    const applied = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Migrations already up to date.");
  } finally {
    await pool.end();
  }
}
