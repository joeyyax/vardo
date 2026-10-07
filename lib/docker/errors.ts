/** Deploy blocked by a policy check. deploy.ts rethrows these instead of swallowing them. */
export class DeployBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployBlockedError";
  }
}
