import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretSealer } from "@platform/security";
import { connectionOwner, NotionProvider, notionTokenResolver, ORGANIZATION_OWNER, PersonalConnectionStore } from "../src/index.js";
import { FakeNotionOAuth, memoryConnectionRows } from "../src/testing.js";

const REDIRECT = "https://brain.example.test/api/connections/notion/callback";
let notion: FakeNotionOAuth;
beforeAll(async () => {
  notion = await new FakeNotionOAuth().start();
});
afterAll(() => notion.close());

const provider = () => new NotionProvider({ clientId: "notion-client", clientSecret: "notion-secret", redirectUri: REDIRECT }, notion.endpoints);
const store = () => new PersonalConnectionStore(memoryConnectionRows(), new SecretSealer(randomBytes(32).toString("base64")));

describe("Notion OAuth provider", () => {
  it("sends the user to Notion's own sign-in and page picker, as the workspace owner", () => {
    const u = new URL(provider().authorizationUrl({ state: "s1" }));
    expect(u.origin + u.pathname).toBe(notion.endpoints.authorize);
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "notion-client", response_type: "code", owner: "user", redirect_uri: REDIRECT, state: "s1" });
  });

  it("exchanges the code with client credentials and remembers the workspace", async () => {
    const p = provider();
    const code = notion.consent(p.authorizationUrl({ state: "s" }), { workspace: "Galin's workspace" });
    const c = await p.exchangeCode(code);
    expect(c).toMatchObject({ accountEmail: "Galin's workspace", scopes: ["read_content"] });
    expect(c.expiresAt.getTime()).toBeGreaterThan(Date.now() + 365 * 86_400_000); // no lifetime given: long-lived
    await expect(p.exchangeCode(code)).rejects.toMatchObject({ kind: "denied" });
    const wrong = new NotionProvider({ clientId: "notion-client", clientSecret: "nope", redirectUri: REDIRECT }, notion.endpoints);
    await expect(wrong.exchangeCode(notion.consent(p.authorizationUrl({ state: "s" }), { workspace: "w" }))).rejects.toMatchObject({ kind: "denied" });
  });

  it("is an organization connection: one per deployment, not per user", () => {
    expect(provider().scope).toBe("organization");
    expect(connectionOwner(provider(), "dana")).toBe(ORGANIZATION_OWNER);
    expect(connectionOwner({ scope: "personal" }, "dana")).toBe("dana");
  });

  it("the ingestion token resolver returns nothing when not connected, and refreshes an expiring token", async () => {
    const s = store();
    const p = provider();
    const resolve = notionTokenResolver(s, p, "cust_demo");
    expect(await resolve()).toBeUndefined();
    notion.expiresIn = 3600;
    const c = await p.exchangeCode(notion.consent(p.authorizationUrl({ state: "s" }), { workspace: "W" }));
    await s.save("cust_demo", ORGANIZATION_OWNER, "notion", { ...c, connectedBy: "dana" });
    expect(await resolve()).toBe(c.accessToken);
    const later = notionTokenResolver(s, p, "cust_demo", () => new Date(Date.now() + 2 * 3600_000));
    const fresh = await later();
    expect(fresh).not.toBe(c.accessToken);
    expect((await s.get("cust_demo", ORGANIZATION_OWNER, "notion"))?.connectedBy).toBe("dana");
    notion.expiresIn = undefined;
  });
});
