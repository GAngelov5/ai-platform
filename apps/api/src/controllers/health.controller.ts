import { Controller, Get, HttpCode, Inject, Res } from "@nestjs/common";
import type { PublicConfig, Readiness } from "@platform/contracts";
import type { Response } from "express";
import { Public } from "../auth/decorators.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

@Controller()
export class HealthController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  /** Liveness: the process is up. */
  @Public()
  @Get("health")
  @HttpCode(200)
  health() {
    return { status: "ok" };
  }

  /** Readiness: dependencies reachable. Returns 503 until they are. */
  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<Readiness> {
    const checks: Readiness["checks"] = {};
    try {
      await this.deps.pingDatabase();
      checks.database = { ok: true };
    } catch {
      checks.database = { ok: false, detail: "unreachable" };
    }
    try {
      checks.knowledge = await this.deps.knowledge.health();
    } catch {
      checks.knowledge = { ok: false, detail: "health check failed" };
    }
    checks.model = { ok: true, detail: this.deps.model.descriptor.provider };
    const ok = Object.values(checks).every((c) => c.ok);
    res.status(ok ? 200 : 503);
    return { status: ok ? "ready" : "not_ready", checks };
  }

  @Public()
  @Get("config/public")
  publicConfig(): PublicConfig {
    const c = this.deps.config;
    return { brandName: c.brandName, environment: c.env, knowledgeProvider: c.knowledge.provider, modelProvider: this.deps.model.descriptor.provider };
  }
}
