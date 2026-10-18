// One deploy's facts and log tail for the Pipeline page's drill-in.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments, environments } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { deployStream } from "@/lib/stream/keys";

export type PipelineDeployDetail = {
  id: string;
  appId: string;
  appSlug: string;
  status: string;
  trigger: string;
  gitSha: string | null;
  gitMessage: string | null;
  envName: string | null;
  imageBytes: number | null;
  buildPeakBytes: number | null;
  transferBytes: number | null;
  fallbackReason: string | null;
  /** The last lines of its log, oldest first. */
  log: string[];
  /** Cancel would be refused: an auto-rollback finishes on its own. */
  cancellable: boolean;
  redeployable: boolean;
};

export const LOG_TAIL = 6;
const STREAM_READ = 80;

/** The last log lines, stage markers left out. */
export function tailLines(lines: string[], n = LOG_TAIL): string[] {
  return lines.filter((l) => l.trim() !== "" && !l.startsWith("[stage]")).slice(-n);
}

async function streamTail(id: string): Promise<string[]> {
  const raw = (await redis.xrevrange(deployStream(id), "+", "-", "COUNT", STREAM_READ)) as [string, string[]][];
  const lines = raw
    .map(([, fields]) => {
      const i = fields.indexOf("line");
      return i >= 0 ? fields[i + 1] : "";
    })
    .reverse();
  return tailLines(lines);
}

export async function readDeployDetail(id: string): Promise<PipelineDeployDetail | null> {
  const [row] = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      appSlug: apps.name,
      systemManaged: apps.isSystemManaged,
      status: deployments.status,
      trigger: deployments.trigger,
      request: deployments.request,
      gitSha: deployments.gitSha,
      gitMessage: deployments.gitMessage,
      envName: environments.name,
      imageBytes: deployments.imageBytes,
      buildPeakBytes: deployments.buildPeakBytes,
      transferBytes: deployments.imageTransferBytes,
      fallbackReason: deployments.buildFallbackReason,
      log: deployments.log,
    })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .leftJoin(environments, eq(environments.id, deployments.environmentId))
    .where(eq(deployments.id, id));
  if (!row) return null;
  const live = row.status === "queued" || row.status === "running";
  const log = live ? await streamTail(id).catch(() => []) : tailLines((row.log ?? "").split("\n"));
  const autoRollback = row.trigger === "rollback" && !row.request?.rollback;
  return {
    id: row.id,
    appId: row.appId,
    appSlug: row.appSlug,
    status: row.status,
    trigger: row.trigger,
    gitSha: row.gitSha,
    gitMessage: row.gitMessage,
    envName: row.envName,
    imageBytes: row.imageBytes,
    buildPeakBytes: row.buildPeakBytes,
    transferBytes: row.transferBytes,
    fallbackReason: row.fallbackReason,
    log,
    cancellable: live && !(row.status === "running" && autoRollback),
    redeployable: !live && !row.systemManaged,
  };
}
