// The Pipeline page's snapshot, shared by the API and the client.

import type { LoopGroup } from "./loops";
import type { Stop } from "./stops";

export type BuilderKind = "local" | "ssh" | "mesh";

/** A build slot in use: by a deploy here, or by a linked instance's build when `deploymentId` is null. */
export type SlotHolder = { token: string; deploymentId: string | null; since: number | null };

export type PipelineBuilder = {
  /** "local" for this server, otherwise the build target's id. */
  id: string;
  name: string;
  kind: BuilderKind;
  slots: number;
  /** Null when no process has checked the target lately. */
  online: boolean | null;
  holders: SlotHolder[];
};

export type PipelineDeploy = {
  id: string;
  appId: string;
  appName: string;
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

export type PipelineTotals = { live: number; elsewhere: number; fellBack: number; failed: number };

export type PipelineSnapshot = {
  at: number;
  instanceName: string;
  deploySlots: { busy: number; total: number };
  builders: PipelineBuilder[];
  deploys: PipelineDeploy[];
  jobs: PipelineJob[];
  loops: LoopGroup[];
  activity: ActivityItem[];
  /** Deploys finished in the last 24 hours. */
  totals: PipelineTotals;
};

/** Each job kind's steps, in order. A step that spans two stops names both. */
export const JOB_STEPS: Record<JobKind, string[]> = {
  backup: ["Dump and upload", "Verify", "Done"],
  drill: ["Restore and check", "Done"],
  cron: ["Run", "Done"],
};
