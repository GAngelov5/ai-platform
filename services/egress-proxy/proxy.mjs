/**
 * Allowlisting egress proxy (ADR 0015). The only service with a route to the
 * internet. It tunnels HTTPS (CONNECT) to an exact list of hosts on port 443
 * and refuses everything else, including plain HTTP. TLS is end to end
 * between the platform and the SaaS API: the proxy never sees tokens or data.
 *
 *   EGRESS_ALLOWED_HOSTS=api.notion.com,oauth2.googleapis.com,www.googleapis.com
 *   EGRESS_PORT=3128
 *
 * No dependencies, so it runs on the plain Node image.
 */
import { createServer } from "node:http";
import { connect } from "node:net";

export function createEgressProxy({ allowedHosts, log = (e) => console.log(JSON.stringify(e)), connectTimeoutMs = 10_000 }) {
  const allowed = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const server = createServer((req, res) => {
    // Plain HTTP forwarding would expose bodies and headers in transit: refused.
    log({ msg: "egress refused", reason: "not CONNECT", method: req.method, at: new Date().toISOString() });
    res.writeHead(405, { "content-type": "text/plain" }).end("only HTTPS (CONNECT) is allowed\n");
  });
  server.on("connect", (req, client, head) => {
    const target = String(req.url ?? "");
    const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(target);
    const host = m?.[1]?.toLowerCase();
    const port = Number(m?.[2]);
    if (!host || port !== 443 || !allowed.has(host)) {
      log({ msg: "egress refused", target: target.slice(0, 200), at: new Date().toISOString() });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect({ host, port, timeout: connectTimeoutMs });
    const started = Date.now();
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = (reason) => {
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
      return reason;
    };
    upstream.once("timeout", () => {
      client.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      close();
    });
    upstream.once("error", () => {
      if (!client.destroyed && client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      close();
    });
    client.once("error", () => close());
    upstream.once("close", () => {
      log({ msg: "egress", host, sentBytes: upstream.bytesWritten, receivedBytes: upstream.bytesRead, ms: Date.now() - started, at: new Date().toISOString() });
      close();
    });
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowedHosts = (process.env.EGRESS_ALLOWED_HOSTS ?? "").split(",");
  if (!allowedHosts.some((h) => h.trim())) {
    console.error("EGRESS_ALLOWED_HOSTS is empty: refusing to start");
    process.exit(78);
  }
  const port = Number(process.env.EGRESS_PORT ?? 3128);
  createEgressProxy({ allowedHosts }).listen(port, "0.0.0.0", () => console.log(JSON.stringify({ msg: "egress proxy started", port, allowedHosts })));
}
