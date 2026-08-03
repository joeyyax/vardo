/** Runtime health. State hues only — classification never borrows from here. */
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

/**
 * Environment tier. One hue of its own, three depths — solid production, half
 * staging, hollow for the ephemeral tiers. Health dots are always solid and
 * always a state hue, so the two read apart in the same header.
 */
export function envTypeDotColor(type: string) {
  return type === "production"
    ? "bg-env-tier"
    : type === "staging"
      ? "bg-env-tier/60 ring-1 ring-inset ring-env-tier"
      : "bg-env-tier-muted ring-1 ring-inset ring-env-tier";
}
