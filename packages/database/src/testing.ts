import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR, type Database } from "./client.js";
import * as schema from "./schema.js";

/**
 * In-process PostgreSQL (PGlite) with the real migrations applied.
 * For tests only: exercises the actual schema and SQL without Docker.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db: db as unknown as Database, close: () => client.close() };
}
