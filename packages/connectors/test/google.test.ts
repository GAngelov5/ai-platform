import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretSealer } from "@platform/security";
import { ConnectorError, GOOGLE_CALENDAR_SCOPE, GoogleCalendarConnector, GoogleOAuthClient, newAuthorizationRequest, PersonalConnectionStore } from "../src/index.js";
import { FakeGoogle, memoryConnectionRows } from "../src/testing.js";

const C = "cust_demo";
const REDIRECT = "https://brain.example.test/api/connections/google/callback";
let google: FakeGoogle;
let clock: Date;

beforeAll(async () => {
  google = await new FakeGoogle().start();
});
afterAll(() => google.close());

function world() {
  const rows = memoryConnectionRows();
  const store = new PersonalConnectionStore(rows, new SecretSealer(randomBytes(32).toString("base64")));
  const oauth = new GoogleOAuthClient({ clientId: "test-client", clientSecret: "test-secret", redirectUri: REDIRECT }, google.endpoints);
  const calendar = new GoogleCalendarConnector({ customerId: C, oauth, store, endpoints: google.endpoints, now: () => clock });
  const connect = async (principal: string, email: string, scope?: string) => {
    const req = newAuthorizationRequest();
    const code = google.consent(oauth.authorizationUrl(req), { email, scope });
    const c = await oauth.exchangeCode(code, req.codeVerifier, clock);
    await store.save(C, principal, "google", c);
    return c;
  };
  return { rows, store, oauth, calendar, connect };
}

beforeEach(() => {
  clock = new Date("2026-10-23T08:00:00Z");
  google.events = {
    "alice@example.test": [
      {
        id: "e1",
        summary: "Atlas steering",
        description: "<b>Agenda</b>: go-live readiness",
        start: { dateTime: "2026-10-24T09:00:00Z" },
        end: { dateTime: "2026-10-24T10:00:00Z" },
        attendees: [{ email: "bob@example.test" }, { displayName: "Carol" }],
      },
      { id: "e2", summary: "Cancelled sync", status: "cancelled", start: { dateTime: "2026-10-24T11:00:00Z" } },
    ],
    "bob@example.test": [{ id: "b1", summary: "Bob's dentist", start: { date: "2026-10-25" } }],
  };
});

describe("Google OAuth", () => {
  it("asks for read-only calendar events with PKCE, a refresh token and nothing broader", () => {
    const { oauth } = world();
    const u = new URL(oauth.authorizationUrl({ state: "s1", codeChallenge: "ch" }));
    expect(u.searchParams.get("scope")).toBe(`openid email ${GOOGLE_CALENDAR_SCOPE}`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(GOOGLE_CALENDAR_SCOPE).toMatch(/calendar\.events\.readonly$/);
  });

  it("exchanges a code only with the matching PKCE verifier, once", async () => {
    const { oauth } = world();
    const req = newAuthorizationRequest();
    const code = google.consent(oauth.authorizationUrl(req), { email: "alice@example.test" });
    await expect(oauth.exchangeCode(code, "wrong-verifier")).rejects.toBeInstanceOf(ConnectorError);
    const code2 = google.consent(oauth.authorizationUrl(req), { email: "alice@example.test" });
    const c = await oauth.exchangeCode(code2, req.codeVerifier);
    expect(c).toMatchObject({ accountEmail: "alice@example.test", scopes: ["openid", "email", GOOGLE_CALENDAR_SCOPE] });
    await expect(oauth.exchangeCode(code2, req.codeVerifier)).rejects.toThrow(/invalid_grant/);
  });

  it("refuses a grant where the user unticked calendar access", async () => {
    const { oauth } = world();
    const req = newAuthorizationRequest();
    const code = google.consent(oauth.authorizationUrl(req), { email: "alice@example.test", scope: "openid email" });
    await expect(oauth.exchangeCode(code, req.codeVerifier)).rejects.toMatchObject({ kind: "denied" });
  });

  it("stores tokens sealed and bound to their owner", async () => {
    const { rows, store, connect } = world();
    const c = await connect("alice", "alice@example.test");
    const row = [...rows.rows.values()][0]!;
    expect(JSON.stringify(row)).not.toContain(c.accessToken);
    expect(JSON.stringify(row)).not.toContain(c.refreshToken!);
    // A sealed token copied onto another user's row doesn't open.
    await rows.upsert({ ...row, principalId: "mallory" });
    await expect(store.get(C, "mallory", "google")).rejects.toThrow();
    expect((await store.get(C, "alice", "google"))?.accessToken).toBe(c.accessToken);
  });
});

describe("Google Calendar connector", () => {
  it("reads only the caller's own calendar, mapped to the calendar tool shape", async () => {
    const { calendar, connect } = world();
    await connect("alice", "alice@example.test");
    await connect("bob", "bob@example.test");
    const r = await calendar.call("events_list", { owner: "alice", days: 3 }, { classification: "read" });
    const events = (r.data as { events: { id: string; title: string; attendees: string[]; agenda: string }[] }).events;
    expect(events).toEqual([
      { id: "gcal-e1", title: "Atlas steering", start: "2026-10-24T09:00:00Z", end: "2026-10-24T10:00:00Z", location: "", attendees: ["bob@example.test", "Carol"], agenda: "Agenda : go-live readiness" },
    ]);
    expect(JSON.stringify(r)).not.toContain("dentist");
    const q = google.calendarRequests.at(-1)!.query;
    expect(q.get("timeMin")).toBe("2026-10-23T08:00:00.000Z");
    expect(q.get("timeMax")).toBe("2026-10-26T08:00:00.000Z");
    expect(q.get("singleEvents")).toBe("true");
  });

  it("says 'not connected' for a user who never connected", async () => {
    const { calendar } = world();
    await expect(calendar.call("events_list", { owner: "carol", days: 3 }, { classification: "read" })).rejects.toMatchObject({ kind: "denied", message: expect.stringMatching(/not connected/) });
  });

  it("refreshes an expired access token, and retries once on 401", async () => {
    const { calendar, connect, store } = world();
    const c = await connect("alice", "alice@example.test");
    clock = new Date(clock.getTime() + 2 * 3600_000); // past expiry
    await calendar.call("events_list", { owner: "alice", days: 1 }, { classification: "read" });
    const after = await store.get(C, "alice", "google");
    expect(after!.accessToken).not.toBe(c.accessToken);
    expect(after!.refreshToken).toBe(c.refreshToken);
    google.invalidateAccessTokens(); // revoked early at Google, still "valid" locally
    await expect(calendar.call("events_list", { owner: "alice", days: 1 }, { classification: "read" })).resolves.toBeTruthy();
  });

  it("forgets a connection whose grant was revoked at Google", async () => {
    const { calendar, connect, store } = world();
    await connect("alice", "alice@example.test");
    google.revokeAll();
    await expect(calendar.call("events_list", { owner: "alice", days: 1 }, { classification: "read" })).rejects.toMatchObject({ kind: "denied", message: expect.stringMatching(/revoked/) });
    expect(await store.get(C, "alice", "google")).toBeUndefined();
  });

  it("is read-only: any other tool or a write classification is refused", async () => {
    const { calendar } = world();
    await expect(calendar.call("events_insert", { owner: "alice" }, { classification: "write" })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(calendar.call("events_list", { owner: "alice", days: 1 }, { classification: "write" })).rejects.toMatchObject({ kind: "invalid_input" });
  });
});
