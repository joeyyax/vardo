/** Runtime health dot color. */
export function statusDotColor(status: string) {
  return status === "active"
    ? "bg-status-success"
    : status === "error"
      ? "bg-status-error"
      : status === "deploying"
        ? "bg-status-info"
        : status === "missing"
          ? "bg-status-warning"
          : "bg-status-neutral";
}

/** Environment tier dot: solid production, half staging, hollow ephemeral. */
export function envTypeDotColor(type: string) {
  return type === "production"
    ? "bg-env-tier"
    : type === "staging"
      ? "bg-env-tier/60 ring-1 ring-inset ring-env-tier"
      : "bg-env-tier-muted ring-1 ring-inset ring-env-tier";
}
