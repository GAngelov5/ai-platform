# Development licences (synthetic)

Signed with the **development** key `dev-2026-10`. Its private key,
`dev-signing-key.pem`, is committed on purpose so tests and developers can
sign licences. Production refuses this key (ADR 0014).

| File | Add-ons | Use |
|---|---|---|
| `dev.licence.json` | Project Assistant, Meeting Preparation, tracker status check | Default outside production |
| `dev-core-only.licence.json` | none | Only the core Knowledge Assistant |
| `dev-expired.licence.json` | all, expired 2026-09-01 (past the 14-day grace) | Expiry behaviour |

Select one with `LICENCE_FILE` (path inside the container, for example
`/repo/fixtures/licence/dev-core-only.licence.json`), then restart the API and
the worker.

Sign a new one: `node scripts/licence.mjs sign body.json --key fixtures/licence/dev-signing-key.pem --key-id dev-2026-10 --out x.licence.json`.
