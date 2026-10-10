import { describe, it, expect } from "vitest";

import { appStatusRows } from "@/lib/attention/app-status-rows";
import { anomalyRows, deployFailureRows } from "@/lib/attention/urgent-rows";
import type { AppCondition } from "@/lib/docker/conditions";
import { deliveryClass } from "@/lib/notifications/delivery-policy";
import { calmQuietSubjects, conditionRows, showsBar, summarize, type AttentionRow } from "@/lib/ui/attention";
import {
  appDownUrgent,
  conditionUrgent,
  deployFailureUrgent,
  URGENT_DEPLOY_WINDOW_MS,
  URGENT_EVENTS,
} from "@/lib/ui/urgency";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const running = { status: "active", parked: false };
const parked = { status: "stopped", parked: true };
const stopped = { status: "stopped", parked: false };

const condition = (kind: AppCondition["kind"], severity: AppCondition["severity"]): AppCondition => ({
  kind,
  severity,
  since: "2026-10-10T11:00:00.000Z",
  detail: "detail",
});

const subject = (name: string, over: Partial<{ status: string; parked: boolean }> = {}) => ({
  id: `id-${name}`,
  name,
  displayName: name,
  status: "active",
  parked: false,
  ...over,
});

describe("urgent signals", () => {
  it("treats a crashed app as urgent and a missing container as routine", () => {
    expect(appDownUrgent({ status: "error" })).toBe(true);
    expect(appDownUrgent({ status: "missing" })).toBe(false);
    expect(appDownUrgent({ status: "active" })).toBe(false);
  });

  it("treats crash loops, critical findings and close certificates as urgent", () => {
    expect(conditionUrgent(condition("crash-looping", "critical"), running)).toBe(true);
    expect(conditionUrgent(condition("self-heal-exhausted", "critical"), running)).toBe(true);
    expect(conditionUrgent(condition("security-findings", "critical"), running)).toBe(true);
    expect(conditionUrgent(condition("cert-expired", "critical"), running)).toBe(true);
    expect(conditionUrgent(condition("cert-expiring", "critical"), running)).toBe(true);
  });

  it("leaves warnings and backup gaps routine", () => {
    expect(conditionUrgent(condition("security-findings", "warning"), running)).toBe(false);
    expect(conditionUrgent(condition("cert-expiring", "warning"), running)).toBe(false);
    expect(conditionUrgent(condition("memory-pressure", "critical"), running)).toBe(false);
    expect(conditionUrgent(condition("unhealthy", "warning"), running)).toBe(false);
    expect(conditionUrgent(condition("backup-stale", "warning"), running)).toBe(false);
    expect(conditionUrgent(condition("backup-missing", "warning"), running)).toBe(false);
  });

  it("counts a failed deploy as urgent only within the hour", () => {
    const failed = (ago: number) => ({ status: "failed", startedAt: new Date(NOW - ago) });
    expect(deployFailureUrgent(failed(5 * 60_000), running, NOW)).toBe(true);
    expect(deployFailureUrgent(failed(URGENT_DEPLOY_WINDOW_MS + 60_000), running, NOW)).toBe(false);
    expect(deployFailureUrgent({ status: "success", startedAt: new Date(NOW) }, running, NOW)).toBe(false);
  });

  // Urgent should line up with what notifications deliver at once.
  it("maps every reason to a notification delivered immediately", () => {
    for (const [reason, events] of Object.entries(URGENT_EVENTS)) {
      for (const type of events) expect(deliveryClass(type), `${reason}: ${type}`).toBe("immediate");
    }
  });
});

describe("parked and stopped apps", () => {
  it("never make a condition urgent", () => {
    for (const app of [parked, stopped]) {
      expect(conditionUrgent(condition("crash-looping", "critical"), app)).toBe(false);
      expect(conditionUrgent(condition("cert-expired", "critical"), app)).toBe(false);
    }
  });

  it("never make a failed deploy urgent", () => {
    expect(deployFailureUrgent({ status: "failed", startedAt: new Date(NOW) }, parked, NOW)).toBe(false);
  });

  it("never raise the bar, whichever row reports them", () => {
    const rows: AttentionRow[] = [
      ...conditionRows([{ ...subject("db", { status: "stopped", parked: true }), conditions: [condition("crash-looping", "critical")] }]),
      {
        key: "backup-failed",
        label: "Backup failed",
        tone: "error",
        group: "backups",
        items: [{ id: "b1", subject: "id-db", name: "db" }],
      },
    ];
    const calm = calmQuietSubjects(rows, new Set(["id-db"]));
    expect(showsBar(summarize(calm))).toBe(false);
  });
});

describe("the bar", () => {
  it("is hidden when nothing is urgent", () => {
    const routine: AttentionRow[] = [
      { key: "condition-memory", label: "Memory", tone: "warning", group: "memory", items: [{ id: "m", name: "api", urgent: false }] },
      { key: "image-updates", label: "Image updates", tone: "neutral", items: [{ id: "u", name: "web" }] },
    ];
    const s = summarize(routine);
    expect(showsBar(s)).toBe(false);
    expect(s.routineFaults).toBe(1);
    expect(s.info.map((r) => r.key)).toEqual(["image-updates"]);
  });

  it("shows for a crash and lists it ahead of routine problems", () => {
    const rows = [
      ...appStatusRows([{ ...subject("api", { status: "error" }), statusChangedAt: new Date(NOW), parentAppId: null }], NOW, 48 * 3_600_000),
      ...conditionRows([{ ...subject("web"), conditions: [condition("memory-pressure", "warning")] }]),
    ];
    const s = summarize(rows);
    expect(showsBar(s)).toBe(true);
    expect(s.urgent.map((g) => g.key)).toEqual(["failed"]);
    expect(s.routine.map((g) => g.key)).toEqual(["memory"]);
    expect(s.urgentFaults).toBe(1);
    expect(s.routineFaults).toBe(1);
  });

  it("shows for Vardo itself degraded", () => {
    const s = summarize([
      { key: "core-service-down", label: "Core service down", tone: "error", group: "vardo", items: [{ id: "loki", name: "Loki", tone: "error" }] },
    ]);
    expect(showsBar(s)).toBe(true);
  });

  it("shows for a backup whose latest outcome failed", () => {
    const s = summarize([
      { key: "backup-failed", label: "Backup failed", tone: "error", group: "backups", items: [{ id: "b", subject: "app", name: "db" }] },
    ]);
    expect(s.urgent.map((g) => g.key)).toEqual(["backups"]);
  });

  it("keeps overdue backups out of it", () => {
    const s = summarize([
      { key: "backup-overdue", label: "Overdue", tone: "warning", group: "backups", items: [{ id: "o", subject: "app", name: "db" }] },
    ]);
    expect(showsBar(s)).toBe(false);
  });
});

describe("deployFailureRows", () => {
  const latest = (appId: string, ago: number, status = "failed") => ({
    id: `d-${appId}`,
    appId,
    status,
    gitSha: "abc1234ff",
    startedAt: new Date(NOW - ago),
    finishedAt: new Date(NOW - ago + 30_000),
  });

  it("marks a fresh failure urgent and links the deploy", () => {
    const [row] = deployFailureRows([subject("api")], [latest("id-api", 10 * 60_000)], NOW);
    expect(row.items[0]).toMatchObject({ urgent: true, tone: "error", href: "/apps/api/deployments/d-id-api" });
  });

  it("keeps an older failure as a routine warning", () => {
    const [row] = deployFailureRows([subject("api")], [latest("id-api", 3 * 3_600_000)], NOW);
    expect(row.items[0]).toMatchObject({ urgent: false, tone: "warning" });
  });

  it("ignores a successful latest deploy and stopped apps", () => {
    expect(deployFailureRows([subject("api")], [latest("id-api", 60_000, "success")], NOW)).toEqual([]);
    expect(deployFailureRows([subject("api", { parked: true, status: "stopped" })], [latest("id-api", 60_000)], NOW)).toEqual([]);
  });
});

describe("anomalyRows", () => {
  it("makes every open anomaly urgent", () => {
    const [row] = anomalyRows([subject("api")], [{ about: "id-api", appId: "id-api", title: "api is sending far more traffic", sentAt: new Date(NOW) }]);
    expect(row.group).toBe("anomaly");
    expect(showsBar(summarize([row]))).toBe(true);
  });

  it("skips a parked app", () => {
    const rows = anomalyRows([subject("api", { parked: true, status: "stopped" })], [{ about: "id-api", appId: "id-api", title: "t", sentAt: new Date(NOW) }]);
    expect(rows).toEqual([]);
  });
});
