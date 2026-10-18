// The Apps page's snapshot and drill-in, shared by the API and the client.

import type { PipelineDeploy } from "@/lib/pipeline/types";

/** A span on the 24-hour ribbon, in epoch ms. `end` is null while it runs. */
export type RibbonSpan = { start: number; end: number | null; failed: boolean };

/** A deploy on the ribbon, with its waits for a builder. */
export type RibbonDeploy = RibbonSpan & { waits: { start: number; end: number | null }[] };

/** Cron runs counted per bucket, so a busy cron stays one mark per slice. */
export type CronMark = { at: number; runs: number; failed: number };

export type Ribbon = {
  deploys: RibbonDeploy[];
  backups: RibbonSpan[];
  crons: CronMark[];
  outages: RibbonSpan[];
};

export type LastDeploy = { at: number; ms: number; status: "success" | "failed" | "rolled_back" | "cancelled" };

/** One row: an app (a stack counts once) with its live metrics and last 24 hours. */
export type AppRow = {
  id: string;
  /** URL name. */
  slug: string;
  name: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  projectName: string | null;
  status: "active" | "stopped" | "error" | "deploying" | "missing";
  /** A deploy queued or running now. */
  deploy: PipelineDeploy | null;
  /** An uptime outage is open. */
  down: boolean;
  /** Percent of one core, summed across containers. Null without samples. */
  cpu: number | null;
  /** Enforced CPU cap in cores. */
  cpuLimit: number | null;
  memory: number | null;
  /** Bytes; null when any container is unlimited. */
  memoryLimit: number | null;
  /** Bytes per second. */
  rx: number | null;
  tx: number | null;
  /** One value per spark step across the last hour, oldest first. Null where nothing was sampled. */
  spark: { cpu: (number | null)[]; memory: (number | null)[]; net: (number | null)[] };
  /** Up share over the last 24 hours, 0 to 1. Null without monitors. */
  uptime: number | null;
  lastDeploy: LastDeploy | null;
  ribbon: Ribbon;
};

export type HostMemory = { totalBytes: number; usedBytes: number; history: (number | null)[] };

export type AppsTotals = {
  deploys: number;
  deploysFailed: number;
  backups: number;
  backupsFailed: number;
  /** Weighted over every monitored app. Null without monitors. */
  uptime: number | null;
  outages: number;
};

export type AppsSnapshot = {
  at: number;
  instanceName: string;
  /** Spark step, ms. */
  sparkStepMs: number;
  host: HostMemory | null;
  totals: AppsTotals;
  apps: AppRow[];
};

export type FocusKind = "rollback" | "failed" | "outage" | "deploy" | "quiet";

/** What the drill-in centers on. */
export type Focus = { kind: FocusKind; at: number; end: number | null; deployId: string | null };

export type DrillEvent = { at: number; text: string; tone: "default" | "issue" | "warn" };

export type AppDrill = {
  appId: string;
  focus: Focus;
  from: number;
  to: number;
  stepMs: number;
  deploys: (PipelineDeploy & { commit: string | null })[];
  backups: RibbonSpan[];
  outages: RibbonSpan[];
  memory: (number | null)[];
  cpu: (number | null)[];
  memoryLimit: number | null;
  events: DrillEvent[];
  /** The newest deploy, for the log link and Redeploy. */
  latestDeployId: string | null;
};
