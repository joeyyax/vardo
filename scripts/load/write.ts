import { authHeaders, getJson, sendJson, type Config } from "./client";
import { createSseParser } from "./sse";
import { summarize, type Summary } from "./stats";

export type StageTimingsRow = Record<string, { ms: number } | undefined>;

export type DeployRow = {
  name: string;
  success: boolean;
  error?: string;
  queueWaitMs: number | null;
  totalMs: number | null;
  executionMs: number | null;
  stages: Record<string, number>;
};

export type DeployResult = {
  apps: number;
  succeeded: number;
  failed: number;
  wallMs: number;
  queueWait: Summary;
  total: Summary;
  execution: Summary;
  stages: Record<string, Summary>;
  rows: DeployRow[];
  cleanupErrors: string[];
};

type AppDetail = {
  app: {
    deployments: {
      id: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      durationMs: number | null;
      stageTimings: StageTimingsRow | null;
    }[];
  };
};

const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/** Streams a deploy to its `done` event and returns that event's payload. */
async function deployAndWait(cfg: Config, appId: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${cfg.url}/api/v1/organizations/${cfg.org}/apps/${appId}/deploy`, {
    method: "POST",
    headers: authHeaders(cfg, { "content-type": "application/json", accept: "text/event-stream" }),
    body: "{}",
    signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`deploy returned ${res.status}`);

  const result: { done: { success: boolean; error?: string } | null } = { done: null };
  const parse = createSseParser((e) => {
    if (e.event === "done") result.done = JSON.parse(e.data);
  });
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  while (!result.done) {
    const { done: closed, value } = await reader.read();
    if (closed) break;
    parse(decoder.decode(value, { stream: true }));
  }
  await reader.cancel().catch(() => {});
  if (!result.done) throw new Error("deploy stream ended without a done event");
  return result.done;
}

/**
 * Deploys `k` tiny apps at once, reports queue wait, total time and per-stage
 * time, then deletes everything it created (also when interrupted).
 */
export async function runDeployScenario(
  cfg: Config,
  k: number,
  image: string,
  log: (msg: string) => void,
): Promise<DeployResult> {
  const runId = Date.now().toString(36);
  const orgPath = `/api/v1/organizations/${cfg.org}`;
  const created: { id: string; name: string }[] = [];
  let projectId: string | null = null;
  let cleaned = false;
  const cleanupErrors: string[] = [];

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    log(`cleaning up ${created.length} scratch apps`);
    for (const app of created) {
      try {
        await sendJson(cfg, "DELETE", `${orgPath}/apps/${app.id}`, { deleteVolumes: true });
      } catch (err) {
        cleanupErrors.push(`app ${app.name} (${app.id}): ${(err as Error).message}`);
      }
    }
    if (projectId) {
      try {
        await sendJson(cfg, "DELETE", `${orgPath}/projects/${projectId}`, {});
      } catch (err) {
        cleanupErrors.push(`project ${projectId}: ${(err as Error).message}`);
      }
    }
  }

  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const rows: DeployRow[] = [];
  let wallMs = 0;
  try {
    const project = await sendJson<{ project: { id: string } }>(cfg, "POST", `${orgPath}/projects`, {
      name: `vardo-load-${runId}`,
      displayName: `Load test ${runId}`,
    });
    projectId = project.project.id;

    for (let i = 0; i < k; i++) {
      const name = `vardo-load-${runId}-${i}`;
      const { app } = await sendJson<{ app: { id: string } }>(cfg, "POST", `${orgPath}/apps`, {
        name,
        displayName: name,
        source: "direct",
        deployType: "image",
        imageName: image,
        containerPort: 80,
        generateDomain: false,
        projectId,
      });
      created.push({ id: app.id, name });
    }
    log(`created ${created.length} apps, deploying concurrently`);

    const started = performance.now();
    const outcomes = await Promise.all(
      created.map((app) =>
        deployAndWait(cfg, app.id).catch((err: Error) => ({ success: false, error: err.message })),
      ),
    );
    wallMs = performance.now() - started;

    for (let i = 0; i < created.length; i++) {
      const app = created[i];
      const row: DeployRow = {
        name: app.name,
        success: outcomes[i].success,
        error: outcomes[i].error,
        queueWaitMs: null,
        totalMs: null,
        executionMs: null,
        stages: {},
      };
      try {
        const detail = await getJson<AppDetail>(cfg, `${orgPath}/apps/${app.id}`);
        const d = detail.app.deployments[0];
        if (d?.finishedAt) {
          row.totalMs = new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime();
          row.executionMs = d.durationMs;
          if (d.durationMs !== null) row.queueWaitMs = Math.max(0, row.totalMs - d.durationMs);
        }
        for (const [stage, t] of Object.entries(d?.stageTimings ?? {})) {
          if (t) row.stages[stage] = t.ms;
        }
      } catch (err) {
        row.error ??= (err as Error).message;
      }
      rows.push(row);
    }
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const ok = rows.filter((r) => r.success);
  const stageNames = [...new Set(rows.flatMap((r) => Object.keys(r.stages)))];
  const stages: Record<string, Summary> = {};
  for (const s of stageNames) {
    stages[s] = summarize(rows.flatMap((r) => (s in r.stages ? [r.stages[s]] : [])));
  }
  return {
    apps: k,
    succeeded: ok.length,
    failed: rows.length - ok.length,
    wallMs,
    queueWait: summarize(rows.flatMap((r) => (r.queueWaitMs === null ? [] : [r.queueWaitMs]))),
    total: summarize(rows.flatMap((r) => (r.totalMs === null ? [] : [r.totalMs]))),
    execution: summarize(rows.flatMap((r) => (r.executionMs === null ? [] : [r.executionMs]))),
    stages,
    rows,
    cleanupErrors,
  };
}
