import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createEgressProxy } from "../proxy.mjs";

let proxy;
let port;
const events = [];

beforeAll(async () => {
  proxy = createEgressProxy({ allowedHosts: ["api.notion.com", "localhost"], log: (e) => events.push(e), connectTimeoutMs: 2000 });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  port = proxy.address().port;
});
afterAll(() => proxy?.close());

/** Sends a raw CONNECT and returns the proxy's status line. */
const connectTo = (target) =>
  new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0]);
      s.destroy();
    });
    s.once("error", reject);
  });

describe("egress proxy", () => {
  it("refuses hosts that are not on the list, and ports other than 443", async () => {
    expect(await connectTo("evil.example.com:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectTo("api.notion.com:80")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectTo("api.notion.com.evil.com:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectTo("10.0.0.1:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(events.filter((e) => e.msg === "egress refused").length).toBeGreaterThanOrEqual(4);
  });

  it("refuses plain HTTP forwarding", async () => {
    const status = await new Promise((resolve) => {
      const r = request({ host: "127.0.0.1", port, path: "http://api.notion.com/v1/search", method: "GET" }, (res) => resolve(res.statusCode));
      r.end();
    });
    expect(status).toBe(405);
  });

  it("tunnels to an allowed host on 443 (connection attempt is made)", async () => {
    // Nothing listens on localhost:443 here, so a tunnel attempt ends in 502 rather than 403.
    const line = await connectTo("localhost:443");
    expect(line === "HTTP/1.1 502 Bad Gateway" || line === "HTTP/1.1 200 Connection Established").toBe(true);
  });
});
