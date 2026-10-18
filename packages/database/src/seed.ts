import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { customers, principals } from "./schema.js";

export interface FixtureIdentity {
  principalId: string;
  displayName: string;
  description: string;
  groups: string[];
  roles: string[];
}

/** Idempotently seeds the customer row and synthetic development principals. */
export async function seedIdentities(
  db: Database,
  customer: { id: string; name: string },
  identities: FixtureIdentity[],
): Promise<void> {
  await db.insert(customers).values(customer).onConflictDoUpdate({ target: customers.id, set: { name: customer.name } });
  for (const p of identities) {
    const values = {
      id: p.principalId,
      customerId: customer.id,
      displayName: p.displayName,
      description: p.description,
      groups: p.groups,
      roles: p.roles,
      origin: "fixture" as const,
      disabled: false,
    };
    await db
      .insert(principals)
      .values(values)
      .onConflictDoUpdate({
        target: [principals.customerId, principals.id],
        set: { displayName: values.displayName, description: values.description, groups: values.groups, roles: values.roles, disabled: false },
        setWhere: sql`${principals.origin} = 'fixture'`,
      });
  }
}
