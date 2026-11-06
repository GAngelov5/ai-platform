/**
 * Creating a Google Calendar event through an approval (ADR 0015 addendum):
 * real migrations on PGlite, the real Google connector against a local fake of
 * Google's OAuth and Calendar endpoints.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { CapabilityRegistry } from "@platform/agents";
import {
  ConnectorRegistry,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GoogleCalendarConnector,
  GoogleOAuthClient,
  newAuthorizationRequest,
  PersonalConnectionStore,
  registerCalendarCreateCapability,
} from "@platform/connectors";
import { FakeGoogle, memoryConnectionRows } from "@platform/connectors/testing";
import { createRepositories, schema, seedIdentities, type Database } from "@platform/database";
import { createTestDatabase } from "@platform/database/testing";
import { createTrustedContext, NotFoundOrForbiddenError, SecretSealer } from "@platform/security";
import { ActionService } from "../src/index.js";

const C = "cust_demo";
let db: Database;
let closeDb: () => Promise<void>;
let google: FakeGoogle;
const ctx = (p: string) => createTrustedContext({ customerId: C, principalId: p, policyVersion: "p1" });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDatabase());
  await seedIdentities(db, { id: C, name: "Demo" }, [
    { principalId: "alice", displayName: "Alice", description: "", groups: ["all-staff"], roles: [] },
    { principalId: "bob", displayName: "Bob", description: "", groups: ["all-staff"], roles: [] },
  ]);
  google = await new FakeGoogle().start();
});
afterAll(async () => {
  google.close();
  await closeDb?.();
});
beforeEach(() => {
  google.events = {};
  google.inserts.length = 0;
});

async function world() {
  const store = new PersonalConnectionStore(memoryConnectionRows(), new SecretSealer(randomBytes(32).toString("base64")));
  const oauth = new GoogleOAuthClient({ clientId: "test-client", clientSecret: "test-secret", redirectUri: "https://brain.example.test/api/connections/google/callback" }, google.endpoints);
  const connector = new GoogleCalendarConnector({ customerId: C, oauth, store, endpoints: google.endpoints });
  const capabilities = new CapabilityRegistry();
  registerCalendarCreateCapability(capabilities, connector, { timeZone: "Europe/Sofia" });
  const repos = createRepositories(db);
  const svc = new ActionService({ db, capabilities, connectors: new ConnectorRegistry([connector]), principals: repos.principals, audit: repos.audit });
  const connect = async (principal: string, email: string) => {
    const req = newAuthorizationRequest();
    const code = google.consent(oauth.authorizationUrl(req), { email });
    await store.save(C, principal, "google", await oauth.exchangeCode(code, req.codeVerifier));
  };
  return { svc, store, oauth, connect };
}

const propose = (svc: ActionService, who = "alice", input: Record<string, unknown> = { title: "Atlas go-live review", start: "2026-11-03T14:00" }) =>
  svc.propose(ctx(who), { capabilityId: "calendar.event.create", input });

describe("calendar.event.create", () => {
  it("creates nothing until approved; the card shows the exact event; approval creates it once on the proposer's calendar", async () => {
    const { svc, connect } = await world();
    await connect("alice", "alice@example.test");
    const p = await propose(svc);
    expect(p).toMatchObject({
      state: "pending_approval",
      operation: 'Create event "Atlas go-live review" on Tue 3 Nov 2026, 14:00–15:00 (Europe/Sofia)',
      destination: "Your Google Calendar (primary)",
    });
    expect(p.risk).toMatch(/nobody is invited/);
    expect(p.payload).toMatchObject({ owner: "alice", start: "2026-11-03T14:00", end: "2026-11-03T15:00", timeZone: "Europe/Sofia", allDay: false });
    expect(google.inserts).toHaveLength(0);

    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    await svc.processOutbox();
    expect(google.inserts).toHaveLength(1);
    expect(google.inserts[0]).toMatchObject({
      email: "alice@example.test",
      sendUpdates: "none",
      body: { summary: "Atlas go-live review", start: { dateTime: "2026-11-03T14:00:00", timeZone: "Europe/Sofia" }, end: { dateTime: "2026-11-03T15:00:00", timeZone: "Europe/Sofia" } },
    });
    const done = await svc.get(ctx("alice"), p.id);
    expect(done.state).toBe("succeeded");
    expect(done.receipt).toMatchObject({ created: true, eventId: p.payload.eventId });
  });

  it("uses the proposing user's own time zone, then a zone the user named, then the platform's", async () => {
    const { svc, connect } = await world();
    await connect("alice", "alice@example.test");
    const input = { title: "Stand-up", start: "2026-11-03T10:00" };
    const mine = await svc.propose(ctx("alice"), { capabilityId: "calendar.event.create", input, timeZone: "America/New_York" });
    expect(mine.operation).toBe('Create event "Stand-up" on Tue 3 Nov 2026, 10:00–11:00 (America/New_York)');
    expect(mine.payload).toMatchObject({ start: "2026-11-03T10:00", timeZone: "America/New_York" });
    const named = await svc.propose(ctx("alice"), { capabilityId: "calendar.event.create", input: { ...input, timeZone: "Asia/Tokyo" }, timeZone: "America/New_York" });
    expect(named.payload).toMatchObject({ timeZone: "Asia/Tokyo" });
    expect((await propose(svc, "alice", input)).payload).toMatchObject({ timeZone: "Europe/Sofia" });
  });

  it("the model can't choose whose calendar: the owner is always the proposer", async () => {
    const { svc } = await world();
    await expect(propose(svc, "alice", { title: "x", start: "2026-11-03T14:00", owner: "bob" })).rejects.toThrow();
  });

  it("another user can't approve it, and a payload changed in storage is refused", async () => {
    const { svc, connect } = await world();
    await connect("alice", "alice@example.test");
    const p = await propose(svc);
    await expect(svc.approve(ctx("bob"), p.id, p.payloadHash)).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    await db.update(schema.actionProposals).set({ payload: { ...p.payload, owner: "bob" } }).where(eq(schema.actionProposals.id, p.id));
    await expect(svc.approve(ctx("alice"), p.id, p.payloadHash)).rejects.toMatchObject({ reason: "payload_mismatch" });
    expect(google.inserts).toHaveLength(0);
  });

  it("duplicate deliveries and concurrent claims create one event", async () => {
    const { svc, connect } = await world();
    await connect("alice", "alice@example.test");
    const p = await propose(svc);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    const outcomes = await Promise.all([svc.executeApproved(p.id), svc.executeApproved(p.id)]);
    expect(outcomes.filter((o) => o === "succeeded")).toHaveLength(1);
    await db.update(schema.outboxEvents).set({ processedAt: null, availableAt: new Date(0) }).where(eq(schema.outboxEvents.aggregateId, p.id));
    await svc.processOutbox();
    expect(google.inserts).toHaveLength(1);
  });

  it("a lost response becomes unknown and reconciles to the event that exists, without creating another", async () => {
    const { svc, connect } = await world();
    await connect("alice", "alice@example.test");
    const p = await propose(svc);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    google.dropNextInsertResponse = true;
    expect(await svc.executeApproved(p.id)).toBe("unknown");
    expect(await svc.reconcile(p.id)).toBe("reconciled");
    expect(google.inserts).toHaveLength(1);
    expect((await svc.get(ctx("alice"), p.id)).state).toBe("succeeded");
  });

  it("says who gets an invitation, and asks Google to send it", async () => {
    const { svc, connect } = await world();
    await connect("alice", "alice@example.test");
    const p = await propose(svc, "alice", { title: "Kick-off", start: "2026-11-04T10:00", end: "2026-11-04T10:30", attendees: ["Bob@Example.test", "bob@example.test"] });
    expect(p.risk).toMatch(/invitation to 1 attendee: bob@example\.test/);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    await svc.processOutbox();
    expect(google.inserts[0]).toMatchObject({ sendUpdates: "all", body: { attendees: [{ email: "bob@example.test" }] } });
  });

  it("a read-only connection fails with a reconnect message; no connection fails as not connected", async () => {
    const { svc, store, oauth } = await world();
    // Stored as it was before this change: the read-only scope only.
    const req = newAuthorizationRequest();
    const code = google.consent(oauth.authorizationUrl(req), { email: "alice@example.test", scope: `openid email ${GOOGLE_CALENDAR_READONLY_SCOPE}` });
    const tokenRes = await fetch(google.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "test-client", client_secret: "test-secret", grant_type: "authorization_code", code, code_verifier: req.codeVerifier, redirect_uri: "https://brain.example.test/api/connections/google/callback" }),
    }).then((r) => r.json() as Promise<{ access_token: string; refresh_token: string }>);
    await store.save(C, "alice", "google", { scopes: ["openid", "email", GOOGLE_CALENDAR_READONLY_SCOPE], accessToken: tokenRes.access_token, refreshToken: tokenRes.refresh_token, expiresAt: new Date(Date.now() + 3_600_000) });
    const p = await propose(svc);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    expect(await svc.executeApproved(p.id)).toBe("failed");
    expect((await svc.get(ctx("alice"), p.id)).lastError).toMatch(/Reconnect/);

    const q = await propose(svc, "bob");
    await svc.approve(ctx("bob"), q.id, q.payloadHash);
    expect(await svc.executeApproved(q.id)).toBe("failed");
    expect((await svc.get(ctx("bob"), q.id)).lastError).toMatch(/not connected/);
    expect(google.inserts).toHaveLength(0);
  });
});
