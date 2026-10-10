// Bodies and payloads for deploy feedback on GitHub. Pure, no I/O.

export type PreviewState = "queued" | "building" | "deploying" | "live" | "failed";

export type PreviewRow = {
  app: string;
  state: PreviewState;
  url?: string | null;
  error?: string | null;
  logUrl?: string | null;
};

export type ProductionState = "live" | "failed" | "rolled_back";

export type ProductionRow = {
  app: string;
  state: ProductionState;
  sha: string;
  durationMs?: number | null;
  url?: string | null;
  error?: string | null;
  logUrl?: string | null;
};

export const previewMarker = (instanceId: string) => `<!-- vardo:pr:${instanceId} -->`;
export const mergedMarker = (instanceId: string) => `<!-- vardo:merged:${instanceId} -->`;

const STATE_LABEL: Record<PreviewState | ProductionState, string> = {
  queued: "Queued",
  building: "Building",
  deploying: "Deploying",
  live: "Live",
  failed: "Failed",
  rolled_back: "Rolled back",
};

const IN_FLIGHT: PreviewState[] = ["queued", "building", "deploying"];

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);

/** Text safe inside a table cell, one line and capped. */
export function cell(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").replace(/[<>]/g, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The PR's state: any failure, then the earliest step still running, then live. */
export function overallState(rows: PreviewRow[]): PreviewState {
  if (rows.length === 0) return "queued";
  if (rows.some((r) => r.state === "failed")) return "failed";
  for (const s of IN_FLIGHT) if (rows.some((r) => r.state === s)) return s;
  return "live";
}

function statusCell(row: { state: PreviewState | ProductionState; error?: string | null; logUrl?: string | null }): string {
  let text = STATE_LABEL[row.state];
  if (row.error && (row.state === "failed" || row.state === "rolled_back")) text += `: ${cell(row.error, 100)}`;
  if (row.logUrl && (row.state === "failed" || row.state === "rolled_back")) text += ` ([log](${row.logUrl}))`;
  return text;
}

export function renderPreviewComment(opts: {
  instanceId: string;
  instanceName: string;
  sha?: string | null;
  rows: PreviewRow[];
  removed?: boolean;
}): string {
  const marker = previewMarker(opts.instanceId);
  const footer = `<sub>${cell(opts.instanceName, 60)}</sub>`;
  if (opts.removed) return [marker, "**Preview removed**", "", footer].join("\n");

  const rows = [...opts.rows].sort((a, b) => a.app.localeCompare(b.app));
  const state = overallState(rows);
  const sha = shortSha(opts.sha);
  const lines = [
    marker,
    `**Preview: ${STATE_LABEL[state].toLowerCase()}**${sha ? ` at \`${sha}\`` : ""}`,
    "",
    "| Service | Status | URL |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${cell(r.app, 60)} | ${statusCell(r)} | ${r.state === "live" && r.url ? r.url : ""} |`),
    "",
    footer,
  ];
  return lines.join("\n");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function renderMergedComment(opts: { instanceId: string; instanceName: string; rows: ProductionRow[] }): string {
  const rows = [...opts.rows].sort((a, b) => a.app.localeCompare(b.app));
  const heading = rows.some((r) => r.state === "rolled_back")
    ? "Rolled back in production"
    : rows.some((r) => r.state === "failed")
      ? "Production deploy failed"
      : "Live in production";
  const lines = [
    mergedMarker(opts.instanceId),
    `**${heading}**`,
    "",
    "| Service | Status | Version | Duration |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => {
      const status = r.state === "live" && r.url ? `[Live](${r.url})` : statusCell(r);
      return `| ${cell(r.app, 60)} | ${status} | \`${shortSha(r.sha)}\` | ${formatDuration(r.durationMs)} |`;
    }),
    "",
    `<sub>${cell(opts.instanceName, 60)}</sub>`,
  ];
  return lines.join("\n");
}

export type CommitState = "pending" | "success" | "failure" | "error";

export function commitStatusPayload(opts: {
  state: CommitState;
  appName: string;
  description: string;
  targetUrl?: string | null;
}) {
  return {
    state: opts.state,
    context: `vardo/${opts.appName}`,
    description: cell(opts.description, 140),
    ...(opts.targetUrl ? { target_url: opts.targetUrl } : {}),
  };
}

/** GitHub environment name: app-scoped so apps in one repo don't replace each other's deployments. */
export function deploymentEnvironment(appName: string, prNumber?: number | null): string {
  return prNumber ? `preview/pr-${prNumber}/${appName}` : `production/${appName}`;
}

export function deploymentPayload(opts: {
  sha: string;
  appName: string;
  prNumber?: number | null;
  instanceId: string;
  deploymentId: string;
}) {
  const preview = !!opts.prNumber;
  return {
    ref: opts.sha,
    environment: deploymentEnvironment(opts.appName, opts.prNumber),
    description: `Vardo deploy of ${opts.appName}`,
    auto_merge: false,
    required_contexts: [] as string[],
    production_environment: !preview,
    transient_environment: preview,
    payload: { vardo: { instance: opts.instanceId, deployment: opts.deploymentId } },
  };
}

export type DeploymentState = "queued" | "in_progress" | "success" | "failure" | "error" | "inactive";

export function deploymentStatusPayload(opts: {
  state: DeploymentState;
  description?: string;
  environmentUrl?: string | null;
  logUrl?: string | null;
}) {
  return {
    state: opts.state,
    ...(opts.description ? { description: cell(opts.description, 140) } : {}),
    ...(opts.environmentUrl ? { environment_url: opts.environmentUrl } : {}),
    ...(opts.logUrl ? { log_url: opts.logUrl } : {}),
  };
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test", ".invalid"];

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** The console origin when the internet can reach it, else null. */
export function publicConsoleUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) return null;
  if (host === "localhost" || !host.includes(".")) return null;
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return null;
  if (isPrivateIpv4(host)) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function deployPageUrl(base: string | null, appId: string, deploymentId: string): string | null {
  return base ? `${base}/apps/${appId}/deployments/${deploymentId}` : null;
}
