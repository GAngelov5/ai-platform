import { pino, type Logger } from "pino";
import { LOG_REDACT_PATHS } from "@platform/security";

export type { Logger };

/** Structured JSON logs with credential and content redaction. */
export function createLogger(level: string, name = "api"): Logger {
  return pino({
    name,
    level,
    redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
