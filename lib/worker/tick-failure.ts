import type { BusEvent } from "@/lib/bus";
import type { Logger } from "@/lib/logger";
import { redactSecrets } from "@/lib/redact";
import { recordFailure } from "./jobs";

/** Consecutive failed passes before a loop raises a system alert. */
export const FAILURE_ALERT_THRESHOLD = 5;

export function logTickFailure(log: Logger, name: string, err: unknown): void {
  log.error(`Loop ${name} failed:`, err);
}

/** Records a failed pass. The fifth failure in a row raises one alert. */
export async function recordTickFailure(log: Logger, name: string, err: unknown): Promise<void> {
  const streak = await recordFailure(name, err);
  if (streak === FAILURE_ALERT_THRESHOLD) await raiseLoopAlert(log, name, err);
}

async function raiseLoopAlert(log: Logger, name: string, err: unknown): Promise<void> {
  // TODO(incident-identity): open a loop.failing incident keyed on `loop:${name}` here instead of a bare event.
  const reason = redactSecrets(err instanceof Error ? err.message : String(err));
  const event: BusEvent = {
    type: "system.service-down",
    title: `Background job failing: ${name}`,
    message: `${name} has failed ${FAILURE_ALERT_THRESHOLD} times in a row. Last error: ${reason}`,
    service: `loop:${name}`,
    description: `Background job ${name}`,
  };
  try {
    const [{ emit }, { adminOrgIds }] = await Promise.all([
      import("@/lib/bus"),
      import("@/lib/notifications/admin-orgs"),
    ]);
    for (const orgId of await adminOrgIds()) emit(orgId, event);
  } catch (alertErr) {
    log.error(`Couldn't raise the alert for ${name}:`, alertErr);
  }
}
