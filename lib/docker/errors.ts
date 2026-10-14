/** Another process, such as the sweeper, closed the deployment row first. The deploy stops without reporting. */
export class DeployClosedElsewhereError extends Error {
  constructor(readonly status: string | null) {
    super(`The deployment was closed elsewhere first${status ? ` (${status})` : ""}`);
    this.name = "DeployClosedElsewhereError";
  }
}

/** Deploy blocked by a policy check. deploy.ts rethrows these instead of swallowing them. */
export class DeployBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployBlockedError";
  }
}
