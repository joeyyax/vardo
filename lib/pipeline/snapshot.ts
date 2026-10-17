// Assembles the Pipeline page's snapshot from deploy rows, the build gate, jobs, loops and recent pipeline events.

import type { LoopStatus } from "@/lib/worker/status";
import type { PipelineEntry } from "./events";
import { groupLoops } from "./loops";
import { describePlacement, placeDeploy } from "./stops";
import type {
  ActivityItem,
  BuilderKind,
  PipelineBuilder,
  PipelineDeploy,
  PipelineJob,
  PipelineSnapshot,
  PipelineTotals,
  SlotHolder,
} from "./types";
import { gateTokenDeployment } from "./events";

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
};

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
};

const ACTIVITY_LIMIT = 8;
/** A failed loop pass shows in the activity this long. */
const LOOP_FAILURE_WINDOW_MS = 10 * 60_000;

export function assembleSnapshot(input: SnapshotInputs): PipelineSnapshot {
  const builders: PipelineBuilder[] = [
    {
      id: "local",
      name: input.instanceName,
      kind: "local",
      slots: Math.max(1, input.localSlots),
      online: true,
      holders: input.gate.local.map(({ token, since }) => ({ token, deploymentId: gateTokenDeployment(token), since })),
    },
    ...input.targets.map((t): PipelineBuilder => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      slots: t.maxConcurrent,
      online: input.gate.ready === null ? null : input.gate.ready.includes(t.id),
      holders: (input.gate.targets[t.id] ?? []).map((token): SlotHolder => ({ token, deploymentId: gateTokenDeployment(token), since: null })),
    })),
  ];
  const builderName = new Map(builders.map((b) => [b.id, b.name]));
  const holding = new Map<string, string>();
  for (const b of builders) for (const h of b.holders) if (h.deploymentId) holding.set(h.deploymentId, b.id);

  // Latest stage event per deploy, and the deploys whose build fell back.
  const stageAt = new Map<string, number>();
  const fellBack = new Set<string>();
  for (const e of input.events) {
    if (e.kind === "stage" && !stageAt.has(e.deploymentId)) stageAt.set(e.deploymentId, e.at);
    if (e.kind === "fallback" && e.deploymentId) fellBack.add(e.deploymentId);
  }

  const deploys = input.deploys.map((row): PipelineDeploy => {
    const placement = placeDeploy(row);
    const held = holding.get(row.id) ?? null;
    const built =
      row.buildOutcome === "target" ? row.buildTargetId : row.buildOutcome === "here" || row.buildOutcome === "fallback" ? "local" : null;
    const builder = held ?? built;
    const name = builder ? (builderName.get(builder) ?? (builder === row.buildTargetId ? row.buildTargetName : null)) : null;
    const since = row.waitingSince ?? stageAt.get(row.id) ?? row.claimedAt ?? row.queuedAt;
    return {
      id: row.id,
      appId: row.appId,
      appName: row.appName,
      status: row.status,
      stage: row.stage,
      ...placement,
      waitReason: row.waitReason,
      builder,
      builderName: name,
      fellBack: row.buildOutcome === "fallback" || fellBack.has(row.id),
      label: describePlacement(placement, { waitReason: row.waitReason, stage: row.stage, builder: name }),
      queuedAt: row.queuedAt,
      stageSince: row.finishedAt ?? since,
      finishedAt: row.finishedAt,
    };
  });

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
  const appNames = new Map([...Object.entries(input.eventApps ?? {}), ...input.deploys.map((d): [string, string] => [d.id, d.appName])]);
  const activity = [
    ...input.events.flatMap((e, i) => {
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

  return {
    at: input.now,
    instanceName: input.instanceName,
    deploySlots: { busy: input.deploys.filter((d) => d.status === "running").length, total: input.deploySlots },
    builders,
    deploys,
    jobs,
    loops,
    activity,
    totals: input.totals,
  };
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
    case "stage":
      if (e.stage === "done" && e.status === "success") return { text: `${app(e.deploymentId)} is live`, tone: "success" };
      if (e.status === "failed") {
        return e.stage === "healthcheck"
          ? { text: `${app(e.deploymentId)} failed its health check; the old version kept serving`, tone: "error" }
          : { text: `${app(e.deploymentId)} failed at ${e.stage}`, tone: "error" };
      }
      if (e.status === "cancelled") return { text: `${app(e.deploymentId)} was cancelled`, tone: "default" };
      return null;
  }
}
