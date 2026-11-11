import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import { getSystemHealth, sanitizeError } from "@/lib/config/health";
import { getInfrastructureSnapshot } from "@/lib/attention/infrastructure";
import { infrastructureRows } from "@/lib/attention/infrastructure-rows";
import { listOpenHostIncidents } from "@/lib/incidents/host";
import { getUpdateStatus } from "@/lib/self-update/status";
import { combinePower, readUpsReports } from "@/lib/ups/power-state";
import { readLoopStatus } from "@/lib/worker/status";
import { workerExpected, workerMode } from "@/lib/worker/mode";
import { isPresent, readWorkers, recentWorkers } from "@/lib/worker/presence";
import { readHostHeartbeats, watchdogSilent } from "@/lib/worker/watch";
import type { McpAuthContext } from "../auth";
import { canAdminInstance } from "../scope";
import { clampLimit, failure, iso, limitArg, text } from "./result";

/** A section's value, or why it couldn't be read. One failing probe doesn't sink the report. */
async function section<T>(read: () => Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await read();
  } catch (err) {
    return { unavailable: sanitizeError(err instanceof Error ? err.message : String(err)) };
  }
}

async function updateSection() {
  const status = await getUpdateStatus();
  const { run, rollout, update, active } = status;
  return {
    version: status.current.version,
    sha: status.current.sha,
    selfDeploy: status.selfDeploy,
    mode: status.policy.mode,
    channel: status.channel,
    checkError: status.checkError
      ? { message: status.checkError.message, rateLimited: status.checkError.rateLimited, resetsAt: status.checkError.resetsAt }
      : null,
    available: update ? { hasUpdate: update.hasUpdate, version: update.targetLabel, commitsBehind: update.commitsBehind } : null,
    noRelease: status.noRelease,
    updating: active ? { from: active.fromVersion, to: active.toVersion, startedAt: iso(new Date(active.startedAt)) } : null,
    lastRun: run
      ? {
          state: run.state,
          trigger: run.trigger,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt ?? null,
          to: run.toLabel,
          error: run.error ?? null,
        }
      : null,
    rollout: rollout
      ? {
          state: rollout.state,
          target: rollout.targetLabel,
          members: rollout.members.map((m) => ({ name: m.name, state: m.state, reason: m.reason })),
        }
      : null,
  };
}

async function servicesSection() {
  const health = await getSystemHealth();
  return {
    services: health.services.map((s) => ({
      name: s.name,
      status: s.status,
      latencyMs: s.latencyMs ?? null,
      error: s.error ?? null,
    })),
    resources: health.resources.map((r) => ({ name: r.name, percent: r.percent, status: r.status, detail: r.detail })),
  };
}

async function coreServicesSection() {
  const rows = infrastructureRows(await getInfrastructureSnapshot(), { canLinkToAdmin: false });
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    tone: row.tone,
    items: row.items.map((item) => ({ name: item.name, detail: item.detail ?? null, since: item.since ?? null })),
  }));
}

async function workerSection() {
  const [beats, { rows, now }] = await Promise.all([readHostHeartbeats(), readWorkers()]);
  return {
    mode: workerMode(),
    expected: workerExpected(),
    ready: beats.workerReady,
    lastWorkerBeat: iso(beats.workerAt),
    lastConsoleBeat: iso(beats.consoleAt),
    watchdog: { lastTick: iso(beats.watchdogAt), silent: watchdogSilent(beats.watchdogAt, now) },
    workers: recentWorkers(rows, now).map((w) => ({
      id: w.id,
      role: w.role,
      slot: w.slot,
      sha: w.gitSha,
      startedAt: iso(w.startedAt),
      lastBeat: iso(w.heartbeatAt),
      present: isPresent(w, now),
      draining: !!w.drainingAt,
      inFlight: w.inFlight,
    })),
  };
}

async function powerSection() {
  const reports = await readUpsReports();
  if (reports.length === 0) return { monitored: false, upses: [] };
  const power = combinePower(reports);
  return {
    monitored: true,
    onBattery: power.onBattery,
    since: iso(power.since),
    fresh: power.fresh,
    upses: reports.map((u) => ({
      name: u.name,
      model: u.model,
      health: u.health,
      status: u.status,
      charge: u.charge,
      runtimeSec: u.runtimeSec,
      load: u.load,
      onBatterySince: iso(u.since),
      replaceBattery: u.replaceBattery,
      testFailed: u.testFailed,
      fresh: u.fresh,
      lastReadAt: iso(u.readAt),
      lastError: u.lastError,
    })),
  };
}

async function incidentsSection() {
  const open = await listOpenHostIncidents();
  return open.map((i) => ({ kind: i.kind, title: i.title, severity: i.severity, openedAt: iso(i.openedAt) }));
}

const STATE_RANK: Record<string, number> = { stale: 0, failing: 1, never: 2, ok: 3 };

/** Instance-wide tools. Registered only for a token with the admin scope. */
export function registerInstanceStatusTools(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_instance_status",
    "Instance health in one call: version and self-update status, service and resource health, core service problems, worker and watchdog state (live workers and those stopped in the last hour), open host incidents and UPS power. Needs a token with the admin scope.",
    {},
    async () => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);

      const [update, health, coreServices, worker, hostIncidents, power] = await Promise.all([
        section(updateSection),
        section(servicesSection),
        section(coreServicesSection),
        section(workerSection),
        section(incidentsSection),
        section(powerSection),
      ]);
      return text({ update, health, coreServices, worker, hostIncidents, power });
    },
  );

  server.tool(
    "vardo_list_tasks",
    "List background loops with role, interval, last tick, last success, last error, failure streak, lease holder, in-flight and a stale flag. Stale and failing loops come first; pass onlyProblems to hide healthy ones. Needs a token with the admin scope.",
    {
      onlyProblems: z.boolean().default(false).describe("Only stale, failing or never-run loops"),
      limit: limitArg,
    },
    async ({ onlyProblems, limit }) => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);

      const [report, { rows: workerRows }] = await Promise.all([readLoopStatus(), readWorkers()]);
      const inFlight = new Set(workerRows.flatMap((w) => w.inFlight));

      const loops = report.loops
        .map((l) => ({
          name: l.name,
          roles: l.roles,
          enabled: l.enabled,
          state: l.state,
          stale: l.stale,
          intervalMs: l.intervalMs,
          lastTickAt: l.lastTickAt,
          lastOkAt: l.lastOkAt,
          lastError: l.lastError,
          consecutiveFailures: l.consecutiveFailures,
          holder: l.lease?.live ? l.lease.holder : l.lastHolder,
          inFlight: inFlight.has(l.name),
        }))
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name));

      const enabled = loops.filter((l) => l.enabled);
      const summary = {
        total: loops.length,
        stale: enabled.filter((l) => l.state === "stale").length,
        failing: enabled.filter((l) => l.state === "failing").length,
        neverRan: enabled.filter((l) => l.state === "never").length,
        disabled: loops.length - enabled.length,
      };
      const shown = onlyProblems ? enabled.filter((l) => l.state !== "ok") : loops;
      const cap = clampLimit(limit);

      return text({ checkedAt: report.checkedAt, summary, loops: shown.slice(0, cap), truncated: shown.length > cap });
    },
  );
}
