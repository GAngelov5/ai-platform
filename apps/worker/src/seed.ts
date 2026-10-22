import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { seedIdentities, type Database, type FixtureIdentity } from "@platform/database";
import { loadSources } from "@platform/knowledge";
import { ingestAll } from "./ingest.js";

export interface IdentityFixtureFile {
  customer: { id: string; name: string };
  principals: FixtureIdentity[];
}

/**
 * Seeds synthetic identities, then ingests the configured sources through the
 * generic pipeline (ADR 0009): fixtures and the synthetic team share by default.
 */
export async function seedFixtures(
  db: Database,
  fixturesRoot: string,
  customerId: string,
  sourcesJson?: string,
  opts: { includeEvalCorpus?: boolean } = {},
): Promise<{ principals: number; documents: number; tombstoned: number; quarantined: number }> {
  const identities = JSON.parse(await readFile(join(fixturesRoot, "identities.json"), "utf8")) as IdentityFixtureFile;
  if (identities.customer.id !== customerId) {
    throw new Error(`fixture customer ${identities.customer.id} does not match CUSTOMER_ID ${customerId}`);
  }
  await seedIdentities(db, identities.customer, identities.principals);
  const reports = await ingestAll(db, customerId, loadSources(sourcesJson, fixturesRoot, opts), () => {});
  const sum = (k: "upserted" | "unchanged" | "aclChanged" | "tombstoned" | "quarantined") => Object.values(reports).reduce((n, r) => n + r[k], 0);
  return {
    principals: identities.principals.length,
    documents: sum("upserted") + sum("unchanged") + sum("aclChanged"),
    tombstoned: sum("tombstoned"),
    quarantined: sum("quarantined"),
  };
}
