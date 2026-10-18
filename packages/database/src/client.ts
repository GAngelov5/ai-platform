import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Schema = typeof schema;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = PgDatabase<PgQueryResultHKT, Schema, any>;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface DatabaseHandle {
  db: Database;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function connectDatabase(url: string, opts: { max?: number } = {}): DatabaseHandle {
  const client = postgres(url, {
    max: opts.max ?? 10,
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => {},
  });
  const db = drizzle(client, { schema }) as unknown as Database;
  return {
    db,
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    close: () => client.end({ timeout: 5 }),
  };
}

/** Controlled deployment step: apply pending migrations, then exit. */
export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Retries a dependency until it is reachable; container ordering is not readiness. */
export async function waitFor<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 30,
  delayMs = 2000,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      onRetry?.(i, err);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label} unavailable after ${attempts} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
}
