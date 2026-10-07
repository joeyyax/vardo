import type { ServiceStatus } from "@/lib/config/health";

type Status = ServiceStatus["status"];

export function serviceDotColor(status: Status): string {
  return status === "healthy"
    ? "bg-status-success"
    : status === "unhealthy"
      ? "bg-status-error"
      : "bg-status-neutral";
}

export function serviceStatusTone(status: Status): string {
  return status === "healthy"
    ? "text-status-success"
    : status === "unhealthy"
      ? "text-status-error"
      : "text-muted-foreground";
}

export function serviceStatusWord(status: Status): string {
  return status === "healthy" ? "Healthy" : status === "unhealthy" ? "Unhealthy" : "Not configured";
}

/** Seconds to one decimal, or milliseconds under one second. */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`;
}

export function formatLatency(ms: number | undefined): string {
  return ms === undefined ? "—" : `${ms} ms`;
}
