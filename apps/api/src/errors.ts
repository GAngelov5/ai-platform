import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ActionConflictError } from "@platform/actions";
import { KnowledgeBackendError } from "@platform/knowledge";
import { NotFoundOrForbiddenError, UnauthenticatedError } from "@platform/security";
import type { Response } from "express";
import { ZodError } from "zod";
import type { PlatformRequest } from "./auth/http.js";
import type { Logger } from "./logger.js";

@Catch()
export class PlatformErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(err: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<PlatformRequest>();
    const requestId = req.requestId;
    const send = (status: number, body: Record<string, unknown>) => res.status(status).json({ ...body, requestId });

    if (err instanceof ZodError) {
      // Report paths and messages only; never echo submitted values.
      return send(400, {
        error: "invalid_request",
        message: "Request validation failed",
        issues: err.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.code === "unrecognized_keys" ? "unrecognized field(s)" : i.message })),
      });
    }
    if (err instanceof ActionConflictError) return send(409, { error: err.reason, message: err.message });
    if (err instanceof NotFoundOrForbiddenError) return send(404, { error: "not_found", message: "Not found" });
    if (err instanceof UnauthenticatedError) return send(401, { error: "unauthenticated", message: "Authentication required" });
    if (err instanceof KnowledgeBackendError) {
      this.logger.error({ requestId, kind: err.kind }, "knowledge backend error");
      return send(503, { error: "knowledge_unavailable", message: "The knowledge service is unavailable" });
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const code = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status === 404 ? "not_found" : "http_error";
      return send(status, { error: code, message: status === 401 ? "Authentication required" : err.message });
    }
    this.logger.error({ requestId, err: { name: (err as Error)?.name, message: (err as Error)?.message } }, "unhandled error");
    return send(500, { error: "internal_error", message: "Internal error" });
  }
}
