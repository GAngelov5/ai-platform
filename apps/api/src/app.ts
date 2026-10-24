import "reflect-metadata";
import { Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import { AuthGuard } from "./auth/guard.js";
import { parseCookies, type PlatformRequest } from "./auth/http.js";
import { ActionsController } from "./controllers/actions.controller.js";
import { AuthController } from "./controllers/auth.controller.js";
import { ConversationsController } from "./controllers/conversations.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { KnowledgeController } from "./controllers/knowledge.controller.js";
import { WorkflowsController } from "./controllers/workflows.controller.js";
import { AdminController } from "./controllers/admin.controller.js";
import { ConnectionsController } from "./controllers/connections.controller.js";
import type { PlatformDeps } from "./deps.js";
import { PlatformErrorFilter } from "./errors.js";
import { DEPS } from "./tokens.js";

export { buildDeps, policySourceIds, DEFAULT_FIXTURES_DIR, DEFAULT_FIXTURES_ROOT, type PlatformDeps } from "./deps.js";
export { createLogger } from "./logger.js";

@Module({})
class AppModule {
  static register(deps: PlatformDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, KnowledgeController, ConversationsController, ActionsController, WorkflowsController, AdminController, ConnectionsController],
      providers: [{ provide: DEPS, useValue: deps }],
    };
  }
}

export async function createApiApp(deps: PlatformDeps): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  app.set("trust proxy", "loopback, uniquelocal");
  app.disable("x-powered-by");
  app.useBodyParser("json", { limit: "64kb" });
  app.setGlobalPrefix("api");

  const log = deps.logger;
  app.use((req: PlatformRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID(); // server-generated; inbound x-request-id is ignored
    req.cookies = parseCookies(req.headers.cookie);
    res.setHeader("x-request-id", req.requestId);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const started = performance.now();
    res.on("finish", () => {
      log.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
          principalId: req.trustedContext?.principalId,
        },
        "request",
      );
    });
    next();
  });

  app.useGlobalGuards(new AuthGuard(app.get(Reflector), deps));
  app.useGlobalFilters(new PlatformErrorFilter(log));
  app.enableShutdownHooks();
  return app;
}
