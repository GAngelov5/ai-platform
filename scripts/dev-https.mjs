#!/usr/bin/env node
/**
 * Local development over HTTPS: https://localhost:3000 (web) in front of the
 * API, worker and synthetic tracker, like `pnpm dev:full`.
 *
 * Uses a self-signed certificate for localhost in .local/certs (git-ignored),
 * made with openssl on first run. It is NOT added to your system's trust
 * store: the browser warns once, and you accept it, as for the Docker stack.
 *
 *   pnpm dev:https
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = `${root}.local/certs`;
const key = `${dir}/localhost-key.pem`;
const cert = `${dir}/localhost.pem`;

if (!existsSync(key) || !existsSync(cert)) {
  mkdirSync(dir, { recursive: true });
  const conf = `${dir}/openssl.cnf`;
  writeFileSync(
    conf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      "CN = localhost",
      "[ext]",
      "subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "basicConstraints = critical, CA:FALSE",
      "",
    ].join("\n"),
  );
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "397", "-keyout", key, "-out", cert, "-config", conf], { stdio: "inherit" });
  console.log(`dev-https: created a self-signed certificate for localhost in ${dir}`);
}

const env = {
  ...process.env,
  // The API checks the Origin header and issues cookies for this origin; shell values win over .env.
  PUBLIC_ORIGIN: "https://localhost:3000",
  COOKIE_SECURE: "true",
  DEV_HTTPS_KEY: key,
  DEV_HTTPS_CERT: cert,
};
const filters = ["@platform/api", "@platform/web", "@platform/worker", "@platform/mcp-atlas-tracker"].flatMap((f) => ["--filter", f]);
const child = spawn("pnpm", ["exec", "turbo", "run", "dev", ...filters], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
