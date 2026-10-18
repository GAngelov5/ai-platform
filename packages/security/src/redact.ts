/** Paths redacted from structured logs. Message content and excerpts are never logged. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers[\"x-csrf-token\"]",
  "res.headers[\"set-cookie\"]",
  "*.password",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.secret",
  "*.content",
  "*.excerpt",
  "*.query",
  "config.databaseUrl",
  "config.ragflow.apiKey",
  "config.model.apiKey",
];

/** Removes credentials from a connection URL before it is displayed or logged. */
export function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}
