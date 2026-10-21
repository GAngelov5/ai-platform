"use client";

import { CSRF_COOKIE, CSRF_HEADER, type ApiError } from "@platform/contracts";

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly body: ApiError | undefined) {
    super(body?.message ?? `Request failed (${status})`);
  }
}

function csrfFromCookie(): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
}

async function ensureCsrf(): Promise<string> {
  const existing = csrfFromCookie();
  if (existing) return decodeURIComponent(existing);
  const r = await fetch("/api/auth/csrf", { credentials: "same-origin" });
  return ((await r.json()) as { token: string }).token;
}

/** Same-origin API call. Identity is the HttpOnly session cookie; nothing identity-related is sent in the body. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET") headers[CSRF_HEADER] = await ensureCsrf();
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (e.g. proxy error page): surface as an API error, never crash the UI.
    json = undefined;
  }
  if (!res.ok) throw new ApiRequestError(res.status, json as ApiError | undefined);
  return json as T;
}

/** POSTs and consumes a `text/event-stream` response, calling onEvent per `data:` JSON line. */
export async function apiStream<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { [CSRF_HEADER]: await ensureCsrf(), "content-type": "application/json", accept: "text/event-stream" },
    credentials: "same-origin",
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let json: ApiError | undefined;
    try {
      json = (await res.json()) as ApiError;
    } catch {
      json = undefined;
    }
    throw new ApiRequestError(res.status, json);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as E);
    }
  }
}
