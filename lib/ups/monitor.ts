// Polls each enabled UPS, records its readings and sends alerts on transitions.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import type { UpsServerRow } from "@/lib/db/schema";
import { resolveSystemIncident } from "@/lib/incidents/system";
import { db } from "@/lib/db";
import { withNutSession, type NutTarget } from "./client";
import { NutError } from "./protocol";
import { UPS_POLL_INTERVAL_MS, advance, readingFromVars, type PollResult } from "./status";
import { listUpsServers, saveUpsState, targetOf } from "./store";
import { storeUpsSample } from "./history";
import { deliverTransitions } from "./alerts";

const log = logger.child("ups");

/** Each poll's budget, inside the interval. */
const POLL_TIMEOUT_MS = 8_000;

function describe(err: unknown): string {
  if (err instanceof NutError) return `NUT error ${err.code}`;
  return err instanceof Error ? err.message : String(err);
}

/** One `LIST VAR` read of a UPS. */
export async function pollUps(target: NutTarget, upsName: string, timeoutMs = POLL_TIMEOUT_MS): Promise<PollResult> {
  try {
    const vars = await withNutSession(target, (s) => s.listVar(upsName), timeoutMs);
    return { ok: true, reading: readingFromVars(vars) };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/** Polls one UPS, saves its state and history and sends its alerts. */
export async function recordPoll(row: UpsServerRow): Promise<void> {
  let target: NutTarget;
  try {
    target = targetOf(row);
  } catch (err) {
    log.warn(`Couldn't decrypt the password for ${row.name}:`, err);
    return;
  }
  const poll = await pollUps(target, row.upsName);
  const now = new Date();
  const { state, transitions } = advance(row.state, poll, now);
  await saveUpsState(row.id, state);
  if (poll.ok) await storeUpsSample(row.id, now.getTime(), poll.reading).catch((err) => log.debug(`UPS history write failed for ${row.name}:`, err));
  if (transitions.length > 0) {
    log.info(`${row.name}: ${transitions.map((t) => `${t.kind} ${t.condition}`).join(", ")}`);
    await deliverTransitions(row, transitions, state, now);
  }
}

export async function tickUps(): Promise<void> {
  const rows = (await listUpsServers()).filter((r) => r.enabled);
  const results = await Promise.allSettled(rows.map(recordPoll));
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") log.error(`UPS poll failed for ${rows[i].name}:`, r.reason);
  }
}

/** Closes a UPS's open incidents without a notice, for a server removed or switched off. */
export async function closeUpsIncidents(serverId: string): Promise<void> {
  const orgs = await db.query.organizations.findMany({ columns: { id: true } });
  const orgIds = orgs.map((o) => o.id);
  for (const kind of ["ups.on-battery", "ups.contact-lost"] as const) {
    await resolveSystemIncident(orgIds, kind, serverId, "Monitoring stopped.", new Date(), { quiet: true });
  }
}

export const upsPollLoop = new IntervalLoop({
  name: "ups-poll",
  intervalMs: UPS_POLL_INTERVAL_MS,
  firstRunMs: 5_000,
  log,
  run: () => tickUps(),
});
