export function statusDotColor(status: string) {
  return status === "active"
    ? "bg-status-success"
    : status === "error"
      ? "bg-status-error"
      : status === "deploying"
        ? "bg-status-info"
        : "bg-status-neutral";
}

export function envTypeDotColor(type: string) {
  return type === "production"
    ? "bg-status-success"
    : type === "staging"
      ? "bg-status-warning"
      : "bg-status-info";
}
