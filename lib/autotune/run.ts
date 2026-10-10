// Auto-adjust memory: a raise after an OOM kill, and an hourly sweep for pressure, settling and lowering.

import { readFile } from "fs/promises";
import os from "os";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { appMemoryAutotune, apps, organizations } from "@/lib/db/schema";
import type { AutotuneNote } from "@/lib/alerts/oom";
import type { AppCondition } from "@/lib/docker/conditions";
import { logger } from "@/lib/logger";
import { detectHost, loadResourceSettings, tierMemoryMb } from "@/lib/resources/host";
import { zonedDateKey, UTC } from "@/lib/time-zone";
import { applyLimitChange, haltAutotune } from "./apply";
import {
  addDailyPeak,
  autotuneEligible,
  decideLower,
  decideRaise,
  DEFAULT_HOST_SHARE,
  LOWER_AFTER_DAYS,
  limitOrigin,
  streakSettled,
  type AutotuneState,
  type DailyPeak,
  type HostMemory,
  type LimitOrigin,
} from "./decide";
import { peakMemory } from "./peaks";

const log = logger.child("memory-autotune");

const MIB = 1024 * 1024;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;


type Env = Record<string, string | undefined>;

/** Instance ceiling and host share: VARDO_AUTOTUNE_MAX_MB and VARDO_AUTOTUNE_HOST_SHARE. */
export function instanceAutotuneLimits(env: Env = process.env): { ceilingMb: number | null; hostShare: number } {
  const max = parseInt(env.VARDO_AUTOTUNE_MAX_MB ?? "", 10);
  const share = Number(env.VARDO_AUTOTUNE_HOST_SHARE);
  return {
    ceilingMb: Number.isInteger(max) && max >= 64 ? max : null,
    hostShare: Number.isFinite(share) && share >= 0.1 && share <= 0.9 ? share : DEFAULT_HOST_SHARE,
  };
}

/** The lowest of the app's, the org's and the instance's ceilings. */
export function ceilingFor(...ceilings: (number | null)[]): number | null {
  const caps = ceilings.filter((n): n is number => typeof n === "number" && n > 0);
  return caps.length ? Math.min(...caps) : null;
}

/** Host RAM and what the kernel says is available. */
export async function readHostMemory(): Promise<HostMemory> {
  try {
    const { parseMeminfo } = await import("@/lib/alerts/host");
    const info = parseMeminfo(await readFile("/proc/meminfo", "utf-8"));
    if (info.MemTotal && info.MemAvailable !== undefined) return { totalBytes: info.MemTotal, availableBytes: info.MemAvailable };
  } catch {
    // Not Linux; fall through to Node's view.
  }
  return { totalBytes: os.totalmem() || null, availableBytes: os.freemem() };
}

/** Built on first use so a mocked schema can still load this module. */
function appColumns() {
  const parents = alias(apps, "autotune_parent");
  return {
    parents,
    columns: {
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      organizationId: apps.organizationId,
      status: apps.status,
      parentAppId: apps.parentAppId,
      composeService: apps.composeService,
      containerName: apps.containerName,
      importedContainerId: apps.importedContainerId,
      memoryLimit: apps.memoryLimit,
      memoryProfile: apps.memoryProfile,
      memoryAutoMinMb: apps.memoryAutoMinMb,
      memoryAutoMaxMb: apps.memoryAutoMaxMb,
      priority: apps.priority,
      containerMemoryLimit: apps.containerMemoryLimit,
      conditions: apps.conditions,
      isSystemManaged: apps.isSystemManaged,
      parentName: parents.name,
      parentPriority: parents.priority,
      orgProfile: organizations.memoryProfile,
      orgMaxMb: organizations.memoryAutoMaxMb,
    },
  };
}

async function loadApps(where: ReturnType<typeof and>) {
  const { parents, columns } = appColumns();
  return db
    .select(columns)
    .from(apps)
    .innerJoin(organizations, eq(organizations.id, apps.organizationId))
    .leftJoin(parents, eq(parents.id, apps.parentAppId))
    .where(where);
}

type AppRow = Awaited<ReturnType<typeof loadApps>>[number];
type StateRow = typeof appMemoryAutotune.$inferSelect;

async function loadStates(appIds: string[]): Promise<Map<string, StateRow>> {
  if (appIds.length === 0) return new Map();
  const rows = await db.select().from(appMemoryAutotune).where(inArray(appMemoryAutotune.appId, appIds));
  return new Map(rows.map((r) => [r.appId, r]));
}

function stateOf(row: StateRow | undefined): AutotuneState {
  return {
    lastRaisedAt: row?.lastRaisedAt ?? null,
    lastChangedAt: row?.lastChangedAt ?? null,
    raiseStreak: row?.raiseStreak ?? 0,
    haltedAt: row?.haltedAt ?? null,
  };
}

/** A limit changed since auto-adjust last wrote it is a person's; the state starts over. */
async function forgetIfOverridden(app: AppRow, row: StateRow | undefined, now: Date): Promise<StateRow | undefined> {
  if (!row || row.appliedMb === null || app.memoryLimit === row.appliedMb) return row;
  const reset = { appliedMb: null, raiseStreak: 0, haltedAt: null, lastRaisedAt: null, lastChangedAt: now, updatedAt: now };
  await db.update(appMemoryAutotune).set(reset).where(eq(appMemoryAutotune.appId, app.id));
  return { ...row, ...reset };
}

function tierDefaultMb(app: AppRow): number {
  return tierMemoryMb(app.priority ?? app.parentPriority ?? "standard");
}

function originOf(app: AppRow, row: StateRow | undefined, containerLimitBytes: number | null): LimitOrigin {
  return limitOrigin({
    appLimitMb: app.memoryLimit,
    appliedMb: row?.appliedMb ?? null,
    containerLimitBytes,
    tierDefaultMb: tierDefaultMb(app),
  });
}

function eligible(app: AppRow, origin: LimitOrigin): boolean {
  if (app.isSystemManaged) return false;
  return autotuneEligible({ appProfile: app.memoryProfile, orgProfile: app.orgProfile, origin });
}

/** The limit in force: the app's own, else what the container runs with. */
function currentMbOf(app: AppRow, containerLimitBytes: number | null): number | null {
  if (app.memoryLimit && app.memoryLimit > 0) return app.memoryLimit;
  return containerLimitBytes ? Math.round(containerLimitBytes / MIB) : null;
}

async function liveContainerIds(app: AppRow, known: string[]): Promise<string[]> {
  const ids = new Set(known);
  try {
    const { listAppContainers } = await import("@/lib/docker/app-containers");
    const running = await listAppContainers({ ...app, parentApp: app.parentName ? { name: app.parentName } : null });
    for (const c of running) ids.add(c.id);
  } catch (err) {
    log.warn(`Couldn't list ${app.name}'s containers:`, (err as Error).message);
  }
  return [...ids];
}

async function raise(
  app: AppRow,
  row: StateRow | undefined,
  input: { trigger: "oom" | "pressure"; currentMb: number; peakBytes: number; host: HostMemory; containerIds: string[]; now: Date },
): Promise<AutotuneNote | null> {
  const limits = instanceAutotuneLimits();
  const state = stateOf(row);
  const decision = decideRaise({
    trigger: input.trigger,
    currentMb: input.currentMb,
    peakBytes: input.peakBytes,
    ceilingMb: ceilingFor(app.memoryAutoMaxMb, app.orgMaxMb, limits.ceilingMb),
    hostShare: limits.hostShare,
    host: input.host,
    state,
    now: input.now.getTime(),
  });

  if (decision.action === "raise") {
    const live = await applyLimitChange({
      organizationId: app.organizationId,
      appId: app.id,
      appName: app.displayName || app.name,
      fromMb: decision.fromMb,
      toMb: decision.toMb,
      direction: "raised",
      reason: input.trigger === "oom" ? "after an OOM kill" : "after 10 minutes over 90% of its limit",
      containerIds: await liveContainerIds(app, input.containerIds),
      raiseStreak: state.raiseStreak + 1,
      now: input.now,
    });
    return { kind: "raised", toMb: decision.toMb, live };
  }
  if (decision.action === "halt") {
    await haltAutotune(app.organizationId, app.id, decision.raises, input.now);
    return { kind: "halted", raises: decision.raises };
  }
  if (decision.reason === "halted") return { kind: "halted", raises: state.raiseStreak };
  if (decision.reason === "no-gain") return null;
  return { kind: "held", reason: decision.reason };
}

/** Raises the limit after a limit kill when auto-adjust covers the app. Null when it doesn't. Never throws. */
export async function autotuneAfterOom(input: {
  appId: string;
  containerIds: string[];
  /** The limit the container was killed at, in bytes. */
  limitBytes: number | null;
  peakBytes: number | null;
  hostKill: boolean;
  now: Date;
}): Promise<AutotuneNote | null> {
  if (input.hostKill) return null;
  try {
    await Promise.all([detectHost(), loadResourceSettings()]);
    const [app] = await loadApps(and(eq(apps.id, input.appId)));
    if (!app) return null;
    const row = await forgetIfOverridden(app, (await loadStates([app.id])).get(app.id), input.now);
    const origin = originOf(app, row, input.limitBytes);
    if (!eligible(app, origin)) return null;

    const currentMb = currentMbOf(app, input.limitBytes);
    if (!currentMb) return null;
    return await raise(app, row, {
      trigger: "oom",
      currentMb,
      peakBytes: Math.max(input.peakBytes ?? 0, currentMb * MIB),
      host: await readHostMemory(),
      containerIds: input.containerIds,
      now: input.now,
    });
  } catch (err) {
    log.error(`Auto-adjust after the kill of ${input.appId} failed:`, err);
    return null;
  }
}

function pressured(conditions: AppCondition[] | null): boolean {
  const c = conditions?.find((x) => x.kind === "memory-pressure");
  return !!c && !c.detail.includes("easing");
}

/** Day keys for the `LOWER_AFTER_DAYS` full UTC days before `now`, oldest first. */
export function previousDays(now: number, count = LOWER_AFTER_DAYS): string[] {
  return Array.from({ length: count }, (_, i) => zonedDateKey(new Date(now - (count - i) * DAY), UTC));
}

/** Every app auto-adjust may cover: opted in, or inheriting an org default that's on. */
async function sweepApps(): Promise<AppRow[]> {
  return loadApps(
    and(
      or(eq(apps.memoryProfile, "auto"), and(isNull(apps.memoryProfile), eq(organizations.memoryProfile, "auto"))),
      eq(apps.isSystemManaged, false),
      // A stack parent's services are their own rows.
      sql`not exists (select 1 from ${apps} c where c.parent_app_id = ${apps.id})`,
    ),
  );
}

/** One hourly pass: records peaks, settles streaks, raises under pressure and lowers idle limits. */
export async function runAutotuneSweep(now: Date = new Date(), lastTroubleAt: (appId: string) => number | null = () => null): Promise<void> {
  await Promise.all([detectHost(), loadResourceSettings()]);
  const rows = await sweepApps();
  if (rows.length === 0) return;

  const at = now.getTime();
  const [states, peaks, host] = await Promise.all([
    loadStates(rows.map((r) => r.id)),
    peakMemory(
      rows.map((r) => ({ id: r.id, name: r.name, parentAppId: r.parentAppId, composeService: r.composeService, parentApp: r.parentName ? { name: r.parentName } : null })),
      at - HOUR,
      at,
    ),
    readHostMemory(),
  ]);
  const today = zonedDateKey(now, UTC);

  for (const app of rows) {
    try {
      const row = await forgetIfOverridden(app, states.get(app.id), now);
      const origin = originOf(app, row, app.containerMemoryLimit);
      if (!eligible(app, origin)) continue;

      const peak = peaks.get(app.id) ?? null;
      const dailyPeaks: DailyPeak[] = peak ? addDailyPeak(row?.dailyPeaks ?? [], today, peak) : (row?.dailyPeaks ?? []);
      const state = stateOf(row);
      const trouble = pressured(app.conditions) ? at : lastTroubleAt(app.id);
      const settled = streakSettled(state, at, trouble);
      await db
        .insert(appMemoryAutotune)
        .values({ appId: app.id, organizationId: app.organizationId, dailyPeaks, updatedAt: now })
        .onConflictDoUpdate({
          target: appMemoryAutotune.appId,
          set: { dailyPeaks, ...(settled ? { raiseStreak: 0 } : {}), updatedAt: now },
        });
      const current = settled ? { ...row!, raiseStreak: 0 } : row;

      const currentMb = currentMbOf(app, app.containerMemoryLimit);
      if (!currentMb || app.status !== "active") continue;

      if (pressured(app.conditions)) {
        await raise(app, current, {
          trigger: "pressure",
          currentMb,
          peakBytes: peak ?? currentMb * MIB * 0.9,
          host,
          containerIds: [],
          now,
        });
        continue;
      }

      // Only a limit auto-adjust set comes back down.
      if (origin !== "autotune") continue;
      const lower = decideLower({
        currentMb,
        floorMb: app.memoryAutoMinMb ?? tierDefaultMb(app),
        peaks: dailyPeaks,
        days: previousDays(at),
        state: stateOf(current),
        now: at,
      });
      if (lower.action === "lower") {
        await applyLimitChange({
          organizationId: app.organizationId,
          appId: app.id,
          appName: app.displayName || app.name,
          fromMb: lower.fromMb,
          toMb: lower.toMb,
          direction: "lowered",
          reason: `after ${LOWER_AFTER_DAYS} quiet days`,
          containerIds: [],
          raiseStreak: 0,
          now,
        });
      }
    } catch (err) {
      log.error(`Auto-adjust sweep failed for ${app.id}:`, err);
    }
  }
}

/** Apps auto-adjust gave up on, while it still covers them. */
export async function haltedApps(): Promise<{ appId: string; appName: string; organizationId: string; raises: number; haltedAt: Date }[]> {
  const { parents, columns } = appColumns();
  const rows = await db
    .select({ state: appMemoryAutotune, ...columns })
    .from(appMemoryAutotune)
    .innerJoin(apps, eq(apps.id, appMemoryAutotune.appId))
    .innerJoin(organizations, eq(organizations.id, apps.organizationId))
    .leftJoin(parents, eq(parents.id, apps.parentAppId))
    .where(isNotNull(appMemoryAutotune.haltedAt));
  const out = [];
  for (const { state, ...app } of rows) {
    if (state.appliedMb !== null && app.memoryLimit !== state.appliedMb) {
      await forgetIfOverridden(app, state, new Date());
      continue;
    }
    if ((app.memoryProfile ?? app.orgProfile) !== "auto") continue;
    out.push({ appId: app.id, appName: app.displayName || app.name, organizationId: app.organizationId, raises: state.raiseStreak, haltedAt: state.haltedAt! });
  }
  return out;
}
