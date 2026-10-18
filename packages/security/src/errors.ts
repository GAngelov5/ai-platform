/** Raised for both "missing" and "not permitted" so callers cannot probe existence. */
export class NotFoundOrForbiddenError extends Error {
  readonly code = "not_found";
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundOrForbiddenError";
  }
}

export class UnauthenticatedError extends Error {
  readonly code = "unauthenticated";
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class ConfigurationError extends Error {
  readonly code = "invalid_configuration";
  constructor(readonly problems: string[]) {
    super(`Invalid platform configuration:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigurationError";
  }
}
