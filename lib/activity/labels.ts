// ---------------------------------------------------------------------------
// Activity view — phrasing
//
// One phrase per action, written to read as "<actor> <phrase> <subject>".
// Standalone phrases are complete on their own and take no subject.
// ---------------------------------------------------------------------------

import type { ActivityGroup, ActivityOutcome } from "./types";
import { actionLabel, asRecord } from "./taxonomy";

type Phrase = {
  /** Verb clause. Pluralized forms are chosen by the caller when count > 1. */
  text: string;
  /** True when the sentence is complete without naming a subject. */
  standalone?: boolean;
};

const PHRASES: Record<string, Phrase> = {
  "deployment.started": { text: "started deploying" },
  "deployment.succeeded": { text: "deployed" },
  "deployment.failed": { text: "failed to deploy" },
  "deployment.cancelled": { text: "cancelled the deploy of" },
  "deployment.rolled_back": { text: "rolled back" },
  "deployment.post_deploy_incomplete": { text: "left post-deploy work unfinished on" },
  "deployment.instant_rollback": { text: "instantly rolled back" },

  "app.created": { text: "created" },
  "app.updated": { text: "updated" },
  "app.deleted": { text: "deleted" },
  "app.adopted": { text: "adopted" },
  "app.imported": { text: "imported" },
  "app.image_updated": { text: "updated the image for" },
  "app.image_update_ignored": { text: "ignored image updates for" },
  "app.image_update_unignored": { text: "stopped ignoring image updates for" },
  "app.restarted": { text: "restarted" },
  "app.stopped": { text: "stopped" },
  "app.started": { text: "started" },
  "app.parked": { text: "parked" },
  "app.unparked": { text: "unparked" },
  "app.crashed": { text: "detected a crash on" },
  "app.crash_looping": { text: "detected a crash loop on" },
  "app.recovered": { text: "confirmed recovery of" },
  "app.self_healed": { text: "restarted an unhealthy container on" },

  "volume.sync": { text: "synced volumes on" },
  "volume.drift_detected": { text: "detected volume drift on" },

  "deploy_key.created": { text: "added deploy key" },
  "deploy_key.deleted": { text: "removed deploy key" },

  "org.trusted_changed": {
    text: "changed organization trust settings",
    standalone: true,
  },
  "project.allow_bind_mounts.updated": {
    text: "changed the bind mount policy on project",
  },
  "project.allow_docker_socket.updated": {
    text: "changed the Docker socket policy on project",
  },

  "transfer.initiated": { text: "started transferring" },
  "transfer.accepted": { text: "accepted the transfer of" },
  "transfer.rejected": { text: "rejected the transfer of" },
  "transfer.cancelled": { text: "cancelled the transfer of" },
};

export function phraseFor(action: string): Phrase {
  return PHRASES[action] ?? { text: actionLabel(action).toLowerCase() };
}

export const OUTCOME_LABELS: Record<ActivityOutcome, string> = {
  success: "Succeeded",
  failure: "Failed",
  neutral: "Changed",
};

/** Status hue per outcome. Neutral rows stay unpainted. */
export const OUTCOME_TONE: Record<
  ActivityOutcome,
  "error" | "success" | "neutral"
> = {
  failure: "error",
  success: "success",
  neutral: "neutral",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

const TRIGGER_ACRONYMS: Record<string, string> = { api: "API", mcp: "MCP" };

/** Acronyms keep their casing; everything else reads as written. */
function triggerLabel(trigger: string): string {
  return TRIGGER_ACRONYMS[trigger] ?? trigger;
}

/**
 * Short trailing facts for a row — duration, what changed, what triggered it.
 * Only read from a single event, since a collapsed run has no one answer.
 */
export function detailsFor(group: ActivityGroup): string[] {
  if (!group.single) return [];
  const metadata = asRecord(group.single.metadata);
  const details: string[] = [];

  const duration = metadata.durationMs;
  if (typeof duration === "number") details.push(`in ${formatDuration(duration)}`);

  const trigger = metadata.trigger;
  if (typeof trigger === "string" && trigger) details.push(`via ${triggerLabel(trigger)}`);

  const changes = metadata.changes;
  if (Array.isArray(changes) && changes.length) {
    details.push(changes.slice(0, 4).join(", "));
  }

  const service = metadata.service;
  const to = metadata.to;
  if (typeof service === "string" && typeof to === "string") {
    details.push(`${service} → ${to}`);
  }

  const totalDrift = metadata.totalDrift;
  if (typeof totalDrift === "number") {
    details.push(`${totalDrift} file${totalDrift === 1 ? "" : "s"}`);
  }

  return details;
}

/** "Alpha, Beta and 3 more" — fleet rows name subjects rather than count them. */
export function subjectSummary(
  labels: string[],
  max = 3
): { shown: string[]; remainder: number } {
  return {
    shown: labels.slice(0, max),
    remainder: Math.max(0, labels.length - max),
  };
}
