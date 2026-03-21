/**
 * Thrown when a deploy is blocked by a policy check (e.g. volume limits).
 * Catch blocks in deploy.ts use `instanceof` to distinguish these from
 * transient errors that should be swallowed.
 */
export class DeployBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployBlockedError";
  }
}
