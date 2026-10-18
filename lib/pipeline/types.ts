// The Pipeline page's snapshot, shared by the API and the client.

import type { LoopGroup } from "./loops";
import type { PipelineMedians } from "./medians";
import type { StageSegment } from "./segments";
import type { Stop } from "./stops";

export type BuilderKind = "local" | "ssh" | "mesh";

/** A build slot in use: by a deploy here, or by a linked instance's build when `deploymentId` is null. `since` comes from the slot's claim event on a target. */
export type SlotHolder = { token: string; deploymentId: string | null; since: number | null };

/** A linked instance turned a deploy's build down. Bytes are null from a peer that didn't send them. */
export type BuilderRefusal = {
  at: number;
  deploymentId: string | null;
  reason: "memory" | "full" | null;
  needBytes: number | null;
  freeBytes: number | null;
};

export type PipelineBuilder = {
  /** "local" for this server, otherwise the build target's id. */
  id: string;
  name: string;
  kind: BuilderKind;
  slots: number;
  /** Null when no process has checked the target lately. */
  online: boolean | null;
  holders: SlotHolder[];
  /** Refusals in the last five minutes, newest first. */
  refusals: BuilderRefusal[];
  /** The linked instance's own builds held its slots at its latest refusal; null when it didn't say or hasn't refused lately. */
  busy: boolean | null;
};

/** Its place in the line it waits in, from the queue's own count: `position` 1 is next. */
export type QueuePlace = { reason: string; position: number; of: number | null; eta: number | null };

/** The builder a deploy waiting for one most likely gets, and when; from slot holders and build medians. */
export type LikelyBuilder = { builder: string; name: string; at: number };

export type PipelineDeploy = {
  id: string;
  appId: string;
  appName: string;
  /** The app's URL name, for links. */
  appSlug: string | null;
  orgName: string | null;
  status: string;
  stage: string | null;
  stop: Stop;
  waiting: boolean;
  waitReason: string | null;
  failed: boolean;
  gone: boolean;
  /** The builder whose slot it holds now, or where it built. */
  builder: string | null;
  builderName: string | null;
  fellBack: boolean;
  label: string;
  queuedAt: number;
  stageSince: number;
  finishedAt: number | null;
  /** "target" while it runs on a build target's deploy slot. */
  claimSlot: string | null;
  /** Shared stages in order; the open one's `end` is null. */
  segments: StageSegment[];
  /** How the image came back from a target, a note on Build. */
  transfer: { via: string; ms: number | null } | null;
  queue: QueuePlace | null;
  /** Null unless it waits for a builder and every slot it could take has a median. */
  next: LikelyBuilder | null;
  /** An auto-rollback's own run: it restores the previous version after a crash. */
  rollback: boolean;
  /** The error a failed run logged last. */
  failure: string | null;
};

export type JobKind = "backup" | "drill" | "cron";

export type PipelineJob = {
  id: string;
  kind: JobKind;
  name: string;
  /** Index into the kind's steps. */
  step: number;
  startedAt: number;
  finishedAt: number | null;
  failed: boolean;
};

export type ActivityTone = "default" | "success" | "warning" | "error";
export type ActivityItem = { id: string; at: number; text: string; tone: ActivityTone };

/**
 * Deploys finished in the last 24 hours. `hourly` counts live ones per hour, oldest first.
 * `medianToLiveMs` is queue to live over the same window; `lastLiveAt` is the latest ever.
 */
export type PipelineTotals = {
  live: number;
  elsewhere: number;
  fellBack: number;
  failed: number;
  medianToLiveMs?: number | null;
  hourly?: number[];
  lastLiveAt?: number | null;
};

/** A scheduled job's next run, or one past due. */
export type ScheduledJob = { kind: JobKind; name: string; at: number };

/**
 * The Pipeline page's state at `at`.
 * - `deploys`: queued, running and finished in the last 30 seconds. `recent`: finished in the hour before that, newest first.
 * - Each deploy's `segments` are its shared stages with start and end; `next` and `queue` say where a waiting one goes.
 * - `deploySlots.busy` counts runs on this server's deploy slots; `onTargets` those on a build target's.
 * - `medians.apps[appId]` holds that app's stage medians over 30 days and `builders[id]` its build median there;
 *   `medians.builders[id]` is any app's build median on that builder. Builds include the image transfer.
 */
export type PipelineSnapshot = {
  at: number;
  instanceName: string;
  deploySlots: { busy: number; total: number; onTargets: number };
  builders: PipelineBuilder[];
  deploys: PipelineDeploy[];
  recent: PipelineDeploy[];
  medians: PipelineMedians;
  jobs: PipelineJob[];
  loops: LoopGroup[];
  activity: ActivityItem[];
  totals: PipelineTotals;
  /** The next few scheduled runs, soonest first. */
  upcoming?: ScheduledJob[];
  /** Backup jobs past due, `at` their last run. */
  overdue?: ScheduledJob[];
};

/** Each job kind's steps, in order. A step that spans two stops names both. */
export const JOB_STEPS: Record<JobKind, string[]> = {
  backup: ["Dump and upload", "Verify", "Done"],
  drill: ["Restore and check", "Done"],
  cron: ["Run", "Done"],
};
