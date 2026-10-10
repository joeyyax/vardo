import type { BusEvent } from "@/lib/bus";
import type { Logger } from "@/lib/logger";
import { recordFailure, recordOk } from "./jobs";

/** Consecutive failed passes before a loop opens an incident. */
export const FAILURE_ALERT_THRESHOLD = 5;

const KIND = "system.loop-failing";
const about = (name: string) => `loop:${name}`;

export function logTickFailure(log: Logger, name: string, err: unknown): void {
  log.error(`Loop ${name} failed:`, err);
}

/** Records a failed pass. The fifth failure in a row opens a system.loop-failing incident. */
export async function recordTickFailure(log: Logger, name: string, err: unknown): Promise<void> {
  const streak = await recordFailure(name, err);
  if (streak === FAILURE_ALERT_THRESHOLD) await openLoopIncident(log, name);
}

/** Records a clean pass. One that ends a streak long enough to have opened an incident resolves it. */
export async function recordTickOk(log: Logger, name: string): Promise<void> {
  const ended = await recordOk(name);
  if (ended >= FAILURE_ALERT_THRESHOLD) await resolveLoopIncident(log, name);
}

async function openLoopIncident(log: Logger, name: string): Promise<void> {
  const title = `Background job failing: ${name}`;
  const event: BusEvent = {
    type: "system.service-down",
    title,
    message: `${name} has failed ${FAILURE_ALERT_THRESHOLD} times in a row. The system health screen shows its last error.`,
    service: about(name),
    description: `Background job ${name}`,
  };
  try {
    const [{ emitSystemIncident }, { adminOrgIds }] = await Promise.all([
      import("@/lib/incidents/system"),
      import("@/lib/notifications/admin-orgs"),
    ]);
    await emitSystemIncident(await adminOrgIds(), event, { kind: KIND, about: about(name), title, severity: "warning" });
  } catch (err) {
    log.error(`Couldn't open the incident for ${name}:`, err);
  }
}

async function resolveLoopIncident(log: Logger, name: string): Promise<void> {
  try {
    const [{ resolveSystemIncident }, { adminOrgIds }] = await Promise.all([
      import("@/lib/incidents/system"),
      import("@/lib/notifications/admin-orgs"),
    ]);
    await resolveSystemIncident(await adminOrgIds(), KIND, about(name), `${name} is running cleanly again.`);
  } catch (err) {
    log.error(`Couldn't resolve the incident for ${name}:`, err);
  }
}
