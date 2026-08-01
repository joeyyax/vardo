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
 * The status a project header already states for all of its apps, or null when
 * they differ. Rows suppress a word matching this so the odd app out reads.
 */
export function uniformStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  return statuses.every((s) => s === statuses[0]) ? statuses[0] : null;
}

export function envTypeDotColor(type: string) {
  return type === "production"
    ? "bg-status-success"
    : type === "staging"
      ? "bg-status-warning"
      : "bg-status-info";
}
