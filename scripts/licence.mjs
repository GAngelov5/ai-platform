#!/usr/bin/env node
/**
 * Vendor-side licence tool (ADR 0014). Not part of a customer deployment.
 *
 *   node scripts/licence.mjs keygen <private-key-out.pem>
 *       Creates an Ed25519 key pair; prints the public key to add to
 *       TRUSTED_LICENCE_KEYS (packages/security/src/licence.ts). Keep the
 *       private key out of this repository (except the development key).
 *
 *   node scripts/licence.mjs sign <licence.json> --key <private.pem> --key-id <id> [--out <file>]
 *       Signs the licence body (the "licence" object of the platform-licence@1
 *       format) and writes the signed licence file.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Same as canonicalJson in packages/security/src/canonical.ts. */
function canonicalJson(v) {
  const sortKeys = (x) =>
    Array.isArray(x)
      ? x.map(sortKeys)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, sortKeys(x[k])]))
        : x;
  return JSON.stringify(sortKeys(v));
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (cmd === "keygen") {
  const out = rest[0];
  if (!out) throw new Error("usage: keygen <private-key-out.pem>");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`private key: ${out}`);
  console.log(`public key (SPKI, base64): ${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`);
} else if (cmd === "sign") {
  const input = rest[0];
  const keyFile = flag("--key");
  const keyId = flag("--key-id");
  if (!input || !keyFile || !keyId) throw new Error("usage: sign <licence.json> --key <private.pem> --key-id <id> [--out <file>]");
  const body = JSON.parse(readFileSync(input, "utf8"));
  const licence = body.licence ?? body;
  if (licence.format !== "platform-licence@1") throw new Error('licence.format must be "platform-licence@1"');
  const key = createPrivateKey(readFileSync(keyFile));
  const signature = sign(null, Buffer.from(canonicalJson(licence), "utf8"), key).toString("base64");
  const signed = `${JSON.stringify({ licence, keyId, signature }, null, 2)}\n`;
  const out = flag("--out");
  if (out) writeFileSync(out, signed);
  else process.stdout.write(signed);
  console.error(`signed ${licence.licenceId} for ${licence.customerId} (expires ${licence.expiresAt}) with ${keyId}; public key ${createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64")}`);
} else {
  console.error("usage: licence.mjs keygen <out.pem> | sign <licence.json> --key <private.pem> --key-id <id> [--out <file>]");
  process.exit(2);
}
