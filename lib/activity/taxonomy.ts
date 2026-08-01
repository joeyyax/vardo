// ---------------------------------------------------------------------------
// Activity view — taxonomy
//
// The activity table stores an action string and a loose metadata blob, with no
// family or outcome column. Both are derived here so the feed, the filters and
// "while you were away" all read the same row the same way.
// ---------------------------------------------------------------------------

import type {
  ActivityFamily,
  ActivityOutcome,
  ActivityRow,
  ClassifiedActivity,
} from "./types";

/** Longest prefix wins, so `project.allow_docker_socket` beats `project`. */
const FAMILY_BY_PREFIX: Array<[string, ActivityFamily]> = [
  ["deployment.", "deploy"],
  ["deploy.", "deploy"],
  ["backup.", "backup"],
  ["cron.", "cron"],
  ["domain.", "domain"],
  ["security.", "security"],
  ["system.", "system"],
  ["deploy_key.", "security"],
  ["org.trusted_changed", "security"],
  ["project.allow_bind_mounts", "security"],
  ["project.allow_docker_socket", "security"],
  ["app.", "app"],
  ["volume.", "app"],
  ["container.", "app"],
  ["transfer.", "org"],
  ["project.", "org"],
  ["org.", "org"],
  ["member.", "org"],
  ["invitation.", "org"],
];

/** Outcomes that the action suffix alone would get wrong. */
const OUTCOME_OVERRIDES: Record<string, ActivityOutcome> = {
  "volume.drift_detected": "failure",
  "transfer.rejected": "failure",
  "transfer.accepted": "success",
  // Automatic rollback means the deploy broke; the manual one is a choice.
  "deployment.rolled_back": "failure",
  "deployment.instant_rollback": "neutral",
  "deployment.cancelled": "neutral",
};

const FAILURE_SUFFIXES = [".failed", ".failure", ".error", ".unreachable"];
const SUCCESS_SUFFIXES = [".succeeded", ".success", ".completed"];

/** Metadata keys that hold failure text, most specific first. */
const ERROR_KEYS = ["error", "reason", "message", "detail"];

export const ALL_FAMILIES: ActivityFamily[] = [
  "deploy",
  "backup",
  "cron",
  "app",
  "domain",
  "security",
  "system",
  "org",
];

export const FAMILY_LABELS: Record<ActivityFamily, string> = {
  deploy: "Deploys",
  backup: "Backups",
  cron: "Cron",
  app: "Apps",
  domain: "Domains",
  security: "Security",
  system: "System",
  org: "Org",
};

export function isFamily(value: string): value is ActivityFamily {
  return (ALL_FAMILIES as string[]).includes(value);
}

export function isOutcome(value: string): value is ActivityOutcome {
  return value === "success" || value === "failure" || value === "neutral";
}

export function familyFor(action: string): ActivityFamily {
  let best: ActivityFamily = "org";
  let bestLength = -1;
  for (const [prefix, family] of FAMILY_BY_PREFIX) {
    if (action.startsWith(prefix) && prefix.length > bestLength) {
      best = family;
      bestLength = prefix.length;
    }
  }
  return best;
}

export function outcomeFor(action: string): ActivityOutcome {
  const override = OUTCOME_OVERRIDES[action];
  if (override) return override;
  if (FAILURE_SUFFIXES.some((s) => action.endsWith(s))) return "failure";
  if (SUCCESS_SUFFIXES.some((s) => action.endsWith(s))) return "success";
  return "neutral";
}

export function asRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

/** Longer errors are truncated at render time; only the first line is kept. */
export function errorTextFrom(metadata: unknown): string | undefined {
  const record = asRecord(metadata);
  for (const key of ERROR_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().split("\n")[0].trim();
    }
  }
  return undefined;
}

/** Readable form of an action for kinds with no hand-written phrasing. */
export function actionLabel(action: string): string {
  const words = action.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Name for the thing acted on. Rows without an app fall back to metadata, then
 * to the action itself, so a subject is never blank.
 */
function subjectLabelFor(row: ActivityRow): string {
  if (row.app) return row.app.displayName || row.app.name;
  const metadata = asRecord(row.metadata);
  for (const key of ["displayName", "name", "domain", "projectId"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return actionLabel(row.action);
}

export function classify(row: ActivityRow): ClassifiedActivity {
  const outcome = outcomeFor(row.action);
  const subjectLabel = subjectLabelFor(row);
  return {
    ...row,
    at: new Date(row.createdAt),
    family: familyFor(row.action),
    outcome,
    // app.deleted carries no appId, so fall back to the name — otherwise two
    // different deleted apps would collapse into one row.
    subjectId: row.app?.id ?? `label:${row.action}:${subjectLabel}`,
    subjectLabel,
    error: outcome === "failure" ? errorTextFrom(row.metadata) : undefined,
  };
}

export function classifyAll(rows: ActivityRow[]): ClassifiedActivity[] {
  return rows.map(classify);
}
