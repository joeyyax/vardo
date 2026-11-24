// The log shipper core service: the collector in logs-only mode.

export function logShipperUrl(): string {
  return (process.env.VARDO_LOG_SHIPPER_URL || "http://log-shipper:9273").replace(/\/+$/, "");
}

/** Unix seconds of the shipper's last delivered batch, or null when it hasn't delivered one. Throws when unreachable. */
export async function shipperLastDelivery(timeoutMs = 2000): Promise<number | null> {
  const res = await fetch(`${logShipperUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { logs_last_success?: number | null };
  return body.logs_last_success || null;
}
