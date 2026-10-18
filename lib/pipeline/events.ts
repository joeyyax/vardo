// Pipeline events for the admin Pipeline page: queue, stage, wait and build-slot changes, on one Redis stream.

import { redis } from "@/lib/redis";
import type { WaitReason } from "@/lib/docker/deploy-logger";
import type { PeerRefusal } from "@/lib/mesh/build-slot";

export const PIPELINE_STREAM = "stream:pipeline";
const MAX_LEN = 1000;

/** `builder` is "local" for this server's builder, or a build target's id. */
export type PipelineEvent =
  | { kind: "queued"; deploymentId: string }
  | { kind: "claimed"; deploymentId: string; slot: "local" | "target" }
  | { kind: "stage"; deploymentId: string; stage: string; status: string }
  | { kind: "wait"; deploymentId: string; reason: WaitReason | null }
  | { kind: "slot"; action: "claim" | "release"; token: string; deploymentId: string | null; builder: string }
  | { kind: "fallback"; deploymentId: string | null; builder: string; name: string; reason: string }
  | {
      kind: "refused";
      deploymentId: string | null;
      builder: string;
      name: string;
      /** Null from a peer that didn't say why. */
      reason: "memory" | "full" | null;
      needBytes: number | null;
      freeBytes: number | null;
      /** The peer's own builds hold slots there. */
      busy: boolean | null;
    };

export type PipelineEntry = PipelineEvent & { at: number };

/** Adds an event to the pipeline stream. Never throws or waits. */
export function publishPipeline(event: PipelineEvent): void {
  try {
    const entry: PipelineEntry = { ...event, at: Date.now() };
    void Promise.resolve(redis.xadd(PIPELINE_STREAM, "MAXLEN", "~", String(MAX_LEN), "*", "e", JSON.stringify(entry))).catch(() => {});
  } catch {
    /* Redis unavailable */
  }
}

/** The deployment a build-gate token belongs to, or null for a linked instance's build. */
export function gateTokenDeployment(token: string): string | null {
  const id = token.slice(0, token.lastIndexOf(":"));
  return id && id !== "build" ? id : null;
}

export function pipelineQueued(deploymentId: string): void {
  publishPipeline({ kind: "queued", deploymentId });
}

export function pipelineClaimed(rows: { id: string; onTarget?: boolean }[]): void {
  for (const row of rows) publishPipeline({ kind: "claimed", deploymentId: row.id, slot: row.onTarget ? "target" : "local" });
}

export function pipelineStage(deploymentId: string, stage: string, status: string): void {
  publishPipeline({ kind: "stage", deploymentId, stage, status });
}

export function pipelineWait(deploymentId: string, reason: WaitReason | null): void {
  publishPipeline({ kind: "wait", deploymentId, reason });
}

/** A build slot taken or freed, here (`builder` null) or on a target. */
export function pipelineSlot(action: "claim" | "release", token: string, builder: string | null = null): void {
  publishPipeline({ kind: "slot", action, token, deploymentId: gateTokenDeployment(token), builder: builder ?? "local" });
}

export function pipelineFallback(token: string, target: { id: string; name: string }, reason: string): void {
  publishPipeline({ kind: "fallback", deploymentId: gateTokenDeployment(token), builder: target.id, name: target.name, reason });
}

/** A linked instance refused a build's claim on its builder. */
export function pipelineRefused(token: string, target: { id: string; name: string }, refusal: PeerRefusal | null): void {
  publishPipeline({
    kind: "refused",
    deploymentId: gateTokenDeployment(token),
    builder: target.id,
    name: target.name,
    reason: refusal?.reason ?? null,
    needBytes: refusal?.needBytes ?? null,
    freeBytes: refusal?.freeBytes ?? null,
    busy: refusal?.busy ?? null,
  });
}

/** Parses a stream entry's fields; null for one that isn't a pipeline event. */
export function parsePipelineEntry(fields: Record<string, string>): PipelineEntry | null {
  try {
    const parsed = JSON.parse(fields.e ?? "") as PipelineEntry;
    return parsed && typeof parsed.kind === "string" && typeof parsed.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}
