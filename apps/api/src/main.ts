import { connectDatabase, waitFor } from "@platform/database";
import { ConfigurationError, LicenceError, loadPlatformConfig, redactUrl } from "@platform/security";
import { buildDeps, createApiApp, createLogger } from "./app.js";

async function main() {
  let config;
  try {
    config = loadPlatformConfig(process.env, { requireDatabase: true });
  } catch (err) {
    if (err instanceof ConfigurationError) {
      console.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);
  if (config.auth.mode === "oidc") {
    logger.fatal("AUTH_MODE=oidc is not implemented in this milestone (Phase 7: customer IdP integration). Refusing to start.");
    process.exit(78);
  }

  const handle = connectDatabase(config.databaseUrl!);
  await waitFor("postgres", handle.ping, 30, 2000, (i, err) =>
    logger.warn({ attempt: i, err: (err as Error).message }, "waiting for postgres"),
  );
  const deps = await buildDeps({ config, db: handle.db, logger, pingDatabase: handle.ping });
  const app = await createApiApp(deps);
  await app.listen(config.api.port, "0.0.0.0");
  logger.info(
    {
      env: config.env,
      port: config.api.port,
      database: redactUrl(config.databaseUrl!),
      knowledge: config.knowledge.provider,
      model: deps.model.descriptor,
      devAuth: config.auth.devAuthEnabled,
      licence: (({ licenceId, status, expiresAt }) => ({ licenceId, status, expiresAt }))(deps.entitlements.summary()),
    },
    "api started",
  );
  const shutdown = async () => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("fatal startup error:", (err as Error).message);
  process.exit(err instanceof LicenceError ? 78 : 1);
});
