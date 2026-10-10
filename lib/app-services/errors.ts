import type { FeatureFlag } from "@/lib/config/features";

// Errors a service throws for the adapter to translate: a 4xx response, notFound() or an MCP refusal.

export class ServiceError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = new.target.name;
  }
}

/** The actor lacks the capability, or the org isn't theirs. */
export class ForbiddenError extends ServiceError {
  constructor(readonly capability?: string) {
    super("You don't have access to this.", 403);
  }
}

/** Nothing by that id or name in the actor's org. */
export class NotFoundError extends ServiceError {
  constructor(readonly thing: string) {
    super(`${thing.charAt(0).toUpperCase()}${thing.slice(1)} not found.`, 404);
  }
}

/** The feature flag the read depends on is off. */
export class FeatureDisabledError extends ServiceError {
  constructor(readonly flag: FeatureFlag) {
    super(`Feature "${flag}" isn't enabled.`, 404);
  }
}

/** The input breaks a rule the service enforces for every caller. */
export class InvalidInputError extends ServiceError {
  constructor(message: string) {
    super(message, 400);
  }
}

/** The write collides with something that already exists. */
export class ConflictError extends ServiceError {
  constructor(message: string) {
    super(message, 409);
  }
}
