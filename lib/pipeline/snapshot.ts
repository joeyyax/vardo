// Assembles the Pipeline page's snapshot from deploy rows, the build gate, jobs, loops and recent pipeline events.

import type { LoopStatus } from "@/lib/worker/status";
import type { PipelineEntry } from "./events";
import { groupLoops } from "./loops";
import { describePlacement, placeDeploy } from "./stops";
import type {
  ActivityItem,
  BuilderKind,
  BuilderRefusal,
  PipelineBuilder,
  PipelineDeploy,
  PipelineJob,
  PipelineSnapshot,
  PipelineTotals,
  ScheduledJob,
  SlotHolder,
} from "./types";
import { gateTokenDeployment } from "./events";
import { SHARED_STAGE_LABELS, sharedStage } from "@/lib/ui/deploy-stage";
import type { StageTimings } from "@/lib/docker/stage-timings";
import type { PipelineMedians } from "./medians";
import { deploySegments } from "./segments";

export type DeployRow = {
  id: string;
  appId: string;
  appName: string;
  status: string;
  stage: string | null;
  waitReason: string | null;
  waitingSince: number | null;
  queuedAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  buildOutcome: string | null;
  buildTargetId: string | null;
  buildTargetName: string | null;
  claimSlot?: string | null;
  timings?: StageTimings | null;
  imageTransfer?: string | null;
  imageTransferMs?: number | null;
  /** The queue's own count for its wait: how many are ahead and in the line. */
  waitAhead?: number | null;
  waitTotal?: number | null;
  waitEta?: number | null;
  appSlug?: string | null;
  orgName?: string | null;
  trigger?: string | null;
  /** The error a failed run logged last. */
  failure?: string | null;
};

/** What turning a row into a deploy reads besides the row. */
export type DeployContext = {
  now: number;
  builderName: Map<string, string>;
  /** Deploy id to the builder whose slot it holds. */
  holding: Map<string, string>;
  /** Each deploy's latest stage event. */
  stageAt: Map<string, number>;
  fellBack: Set<string>;
};

export function toPipelineDeploy(row: DeployRow, ctx: DeployContext): PipelineDeploy {
  const placement = placeDeploy(row);
  const held = ctx.holding.get(row.id) ?? null;
  const built =
    row.buildOutcome === "target" ? row.buildTargetId : row.buildOutcome === "here" || row.buildOutcome === "fallback" ? "local" : null;
  const builder = held ?? built;
  const name = builder ? (ctx.builderName.get(builder) ?? (builder === row.buildTargetId ? row.buildTargetName : null)) : null;
  const since = row.waitingSince ?? ctx.stageAt.get(row.id) ?? row.claimedAt ?? row.queuedAt;
  return {
    id: row.id,
    appId: row.appId,
    appName: row.appName,
    appSlug: row.appSlug ?? null,
    orgName: row.orgName ?? null,
    status: row.status,
    stage: row.stage,
    ...placement,
    waitReason: row.waitReason,
    builder,
    builderName: name,
    fellBack: row.buildOutcome === "fallback" || ctx.fellBack.has(row.id),
    label: describePlacement(placement, { waitReason: row.waitReason, stage: row.stage, builder: name, status: row.status }),
    queuedAt: row.queuedAt,
    stageSince: row.finishedAt ?? since,
    finishedAt: row.finishedAt,
    claimSlot: row.claimSlot ?? null,
    segments: deploySegments({ ...row, timings: row.timings ?? null }, ctx.now),
    transfer: row.imageTransfer ? { via: row.imageTransfer, ms: row.imageTransferMs ?? null } : null,
    queue: queuePlace(row),
    next: null,
    rollback: row.trigger === "rollback",
    failure: row.failure ?? null,
  };
}

export type GateState = {
  /** This server's running builds and when each was admitted. */
  local: { token: string; since: number | null }[];
  /** Each target's running tokens. */
  targets: Record<string, string[]>;
  /** Targets a process found ready lately; null when none checked within the minute. */
  ready: string[] | null;
};

export type TargetConfig = { id: string; name: string; kind: BuilderKind; maxConcurrent: number };

export type BackupRow = { id: string; name: string; status: string; startedAt: number; finishedAt: number | null; verifying: boolean };
export type DrillRow = { backupId: string; name: string; startedAt: number; finishedAt: number | null; failed: boolean };
export type CronRow = { id: string; name: string; running: boolean; startedAt: number; finishedAt: number | null; failed: boolean };

export type SnapshotInputs = {
  now: number;
  instanceName: string;
  deploySlots: number;
  localSlots: number;
  gate: GateState;
  targets: TargetConfig[];
  deploys: DeployRow[];
  backups: BackupRow[];
  drills: DrillRow[];
  crons: CronRow[];
  loops: LoopStatus[];
  /** Recent pipeline events, newest first. */
  events: PipelineEntry[];
  /** App names for deploys the events name that are no longer in flight. */
  eventApps?: Record<string, string>;
  totals: PipelineTotals;
  /** Deploys finished before the linger, within the hour, newest first. */
  recent?: DeployRow[];
  medians?: PipelineMedians;
  upcoming?: ScheduledJob[];
  overdue?: ScheduledJob[];
};

const ACTIVITY_LIMIT = 8;
/** A refusal marks its builder this long. */
export const REFUSAL_WINDOW_MS = 5 * 60_000;
const NO_MEDIANS: PipelineMedians = { apps: {}, builders: {} };
/** A failed loop pass shows in the activity this long. */
const LOOP_FAILURE_WINDOW_MS = 10 * 60_000;

export function assembleSnapshot(input: SnapshotInputs): PipelineSnapshot {
  // Latest stage event per deploy, the deploys whose build fell back, when each target slot was claimed and each builder's refusals.
  const stageAt = new Map<string, number>();
  const fellBack = new Set<string>();
  const claimedAt = new Map<string, number>();
  const refusals = new Map<string, BuilderRefusal[]>();
  const busy = new Map<string, boolean | null>();
  for (const e of input.events) {
    if (e.kind === "stage" && !stageAt.has(e.deploymentId)) stageAt.set(e.deploymentId, e.at);
    if (e.kind === "fallback" && e.deploymentId) fellBack.add(e.deploymentId);
    if (e.kind === "slot" && e.action === "claim" && !claimedAt.has(e.token)) claimedAt.set(e.token, e.at);
    if (e.kind === "refused" && input.now - e.at < REFUSAL_WINDOW_MS) {
      const list = refusals.get(e.builder) ?? [];
      if (!busy.has(e.builder)) busy.set(e.builder, e.busy);
      if (!list.some((r) => r.deploymentId === e.deploymentId)) {
        list.push({ at: e.at, deploymentId: e.deploymentId, reason: e.reason, needBytes: e.needBytes, freeBytes: e.freeBytes });
      }
      refusals.set(e.builder, list);
    }
  }

  const builders: PipelineBuilder[] = [
    {
      id: "local",
      name: input.instanceName,
      kind: "local",
      slots: Math.max(1, input.localSlots),
      online: true,
      holders: input.gate.local.map(({ token, since }) => ({ token, deploymentId: gateTokenDeployment(token), since })),
      refusals: [],
      busy: null,
    },
    ...input.targets.map((t): PipelineBuilder => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      slots: t.maxConcurrent,
      online: input.gate.ready === null ? null : input.gate.ready.includes(t.id),
      holders: (input.gate.targets[t.id] ?? []).map((token): SlotHolder => ({ token, deploymentId: gateTokenDeployment(token), since: claimedAt.get(token) ?? null })),
      refusals: refusals.get(t.id) ?? [],
      busy: busy.get(t.id) ?? null,
    })),
  ];
  const ctx: DeployContext = {
    now: input.now,
    builderName: new Map(builders.map((b) => [b.id, b.name])),
    holding: new Map(),
    stageAt,
    fellBack,
  };
  for (const b of builders) for (const h of b.holders) if (h.deploymentId) ctx.holding.set(h.deploymentId, b.id);
  const builderName = ctx.builderName;
  const toDeploy = (row: DeployRow) => toPipelineDeploy(row, ctx);
  const medians = input.medians ?? NO_MEDIANS;
  const deploys = withLikelyBuilders(input.deploys.map(toDeploy), builders, medians, input.now);
  const recent = (input.recent ?? []).map(toDeploy);

  const jobs: PipelineJob[] = [
    ...input.backups.map((b): PipelineJob => ({
      id: `backup:${b.id}`,
      kind: "backup",
      name: b.name,
      step: b.finishedAt !== null && !b.verifying ? 2 : b.verifying ? 1 : 0,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      failed: b.status === "failed",
    })),
    ...input.drills.map((d): PipelineJob => ({
      id: `drill:${d.backupId}`,
      kind: "drill",
      name: d.name,
      step: d.finishedAt === null ? 0 : 1,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt,
      failed: d.failed,
    })),
    ...input.crons.map((c): PipelineJob => ({
      id: `cron:${c.id}`,
      kind: "cron",
      name: c.name,
      step: c.running ? 0 : 1,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      failed: c.failed,
    })),
  ];

  const loops = groupLoops(input.loops);
  const appNames = new Map([
    ...Object.entries(input.eventApps ?? {}),
    ...[...input.deploys, ...(input.recent ?? [])].map((d): [string, string] => [d.id, d.appName]),
  ]);
  const refusalsListed = new Set<string>();
  const activity = [
    ...input.events.flatMap((e, i) => {
      // A deploy re-asks a full peer every few seconds; only its latest refusal there is listed.
      if (e.kind === "refused") {
        const key = `${e.deploymentId}:${e.builder}`;
        if (refusalsListed.has(key)) return [];
        refusalsListed.add(key);
      }
      const text = describeEvent(e, { appNames, builderName, instanceName: input.instanceName });
      return text ? [{ id: `${e.at}:${i}`, at: e.at, ...text }] : [];
    }),
    ...loops.flatMap((g) =>
      g.loops
        .filter((l) => l.failed && l.lastTickAt !== null && input.now - l.lastTickAt < LOOP_FAILURE_WINDOW_MS)
        .map((l): ActivityItem => ({ id: `loop:${l.name}`, at: l.lastTickAt!, text: `${l.label} failed its last run`, tone: "error" })),
    ),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, ACTIVITY_LIMIT);

  const runningRows = input.deploys.filter((d) => d.status === "running");
  const onTargets = runningRows.filter((d) => d.claimSlot === "target").length;
  return {
    at: input.now,
    instanceName: input.instanceName,
    deploySlots: { busy: runningRows.length - onTargets, total: input.deploySlots, onTargets },
    builders,
    deploys,
    recent,
    medians: pickMedians(medians, [...deploys, ...recent]),
    jobs,
    loops,
    activity,
    totals: input.totals,
    upcoming: input.upcoming ?? [],
    overdue: input.overdue ?? [],
  };
}

/** The medians of the apps on the page only. */
function pickMedians(all: PipelineMedians, deploys: PipelineDeploy[]): PipelineMedians {
  const ids = new Set(deploys.map((d) => d.appId));
  return { apps: Object.fromEntries(Object.entries(all.apps).filter(([id]) => ids.has(id))), builders: all.builders };
}

/** Its line's place from the queue's count, for a deploy waiting on a deploy slot or the builder. */
function queuePlace(row: DeployRow): PipelineDeploy["queue"] {
  if (!row.waitReason || row.waitAhead == null) return null;
  return { reason: row.waitReason, position: row.waitAhead + 1, of: row.waitTotal ?? null, eta: row.waitEta ?? null };
}

/**
 * Fills `next` for deploys waiting for a builder: in queue order, each takes the slot that frees soonest,
 * a slot freeing at its holder's start plus its build median. A deploy on a target's deploy slot only takes a target's.
 * A slot whose free time is unknown is never picked; with none known, `next` stays null.
 */
export function withLikelyBuilders(deploys: PipelineDeploy[], builders: PipelineBuilder[], medians: PipelineMedians, now: number): PipelineDeploy[] {
  const appOf = new Map(deploys.map((d) => [d.id, d.appId]));
  const buildMs = (builder: string, appId: string | null | undefined) =>
    (appId ? medians.apps[appId]?.builders[builder] : undefined) ?? medians.builders[builder] ?? null;
  const slots = builders
    .filter((b) => b.online !== false)
    .flatMap((b) =>
      Array.from({ length: Math.max(b.slots, b.holders.length) }, (_, i) => {
        const h = b.holders[i];
        if (!h) return { builder: b, freeAt: now };
        const ms = buildMs(b.id, h.deploymentId ? appOf.get(h.deploymentId) : null);
        return { builder: b, freeAt: h.since !== null && ms !== null ? Math.max(now, h.since + ms) : Infinity };
      }),
    );
  const waiting = deploys
    .filter((d) => d.waitReason === "build-slot" && d.status === "running")
    .sort((a, b) => (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity) || a.queuedAt - b.queuedAt);
  const next = new Map<string, PipelineDeploy["next"]>();
  for (const d of waiting) {
    const open = slots.filter((s) => (d.claimSlot === "target" ? s.builder.id !== "local" : true));
    const best = open.reduce<(typeof slots)[number] | null>((a, s) => (s.freeAt < (a?.freeAt ?? Infinity) ? s : a), null);
    if (!best) {
      next.set(d.id, null);
      continue;
    }
    next.set(d.id, { builder: best.builder.id, name: best.builder.name, at: best.freeAt });
    const ms = buildMs(best.builder.id, d.appId);
    best.freeAt = ms === null ? Infinity : best.freeAt + ms;
  }
  return deploys.map((d) => (next.has(d.id) ? { ...d, next: next.get(d.id)! } : d));
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** " (needs 6.0 GiB, 2.1 GiB free)", " (busy with its own builds)", or nothing. */
function refusalWhy(e: Extract<PipelineEntry, { kind: "refused" }>): string {
  if (e.reason === "memory" && e.needBytes !== null && e.freeBytes !== null) return ` (needs ${gib(e.needBytes)}, ${gib(e.freeBytes)} free)`;
  if (e.busy) return " (busy with its own builds)";
  if (e.reason === "memory") return " (not enough memory)";
  return e.reason === "full" ? " (its builder is full)" : "";
}

type DescribeContext = { appNames: Map<string, string>; builderName: Map<string, string>; instanceName: string };

/** An activity line for an event, or null for one too routine to list. */
export function describeEvent(e: PipelineEntry, ctx: DescribeContext): Omit<ActivityItem, "id" | "at"> | null {
  const app = (id: string | null) => (id ? (ctx.appNames.get(id) ?? "A deploy") : "A deploy");
  const where = (builder: string) => (builder === "local" ? ctx.instanceName : (ctx.builderName.get(builder) ?? "a build target"));
  switch (e.kind) {
    case "queued":
      return { text: `${app(e.deploymentId)} joined the queue`, tone: "default" };
    case "claimed":
      return e.slot === "target" ? { text: `${app(e.deploymentId)} took a deploy slot that builds elsewhere`, tone: "default" } : null;
    case "wait":
      if (e.reason === "build-slot") return { text: `${app(e.deploymentId)} is waiting for a builder`, tone: "warning" };
      if (e.reason === "deploy-slot") return { text: `${app(e.deploymentId)} is waiting for a deploy slot`, tone: "warning" };
      return null;
    case "slot":
      if (e.action !== "claim") return null;
      if (!e.deploymentId) return { text: `A linked instance is building on ${where(e.builder)}`, tone: "default" };
      return e.builder === "local" ? null : { text: `${app(e.deploymentId)} is building on ${where(e.builder)}`, tone: "default" };
    case "fallback":
      return { text: `${app(e.deploymentId)}: ${e.name} couldn't build (${e.reason}); building on ${ctx.instanceName} instead`, tone: "warning" };
    case "refused":
      return { text: `${app(e.deploymentId)}: ${e.name} turned the build down${refusalWhy(e)}; waiting for a builder`, tone: "warning" };
    case "stage":
      if (e.stage === "done" && e.status === "success") return { text: `${app(e.deploymentId)} is live`, tone: "success" };
      if (e.status === "failed") {
        const shared = sharedStage(e.stage);
        return e.stage === "healthcheck"
          ? { text: `${app(e.deploymentId)} failed its health check; the old version kept serving`, tone: "error" }
          : { text: `${app(e.deploymentId)} failed at ${shared ? SHARED_STAGE_LABELS[shared].toLowerCase() : e.stage}`, tone: "error" };
      }
      if (e.status === "cancelled") return { text: `${app(e.deploymentId)} was cancelled`, tone: "default" };
      return null;
  }
}
