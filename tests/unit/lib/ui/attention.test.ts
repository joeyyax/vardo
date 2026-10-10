import { describe, it, expect } from "vitest";

import {
  announceAttention,
  attentionPanelGroup,
  attentionPanelKey,
  conditionRows,
  groupAttention,
  isInlineRow,
  mergeAttentionRows,
  summarize,
  INLINE_SUBJECT_LIMIT,
  type AttentionRow,
} from "@/lib/ui/attention";
import type { AppCondition } from "@/lib/docker/conditions";

function app(name: string, conditions: AppCondition[]) {
  return { id: `id-${name}`, name, displayName: name, conditions };
}

const crashLoop: AppCondition = {
  kind: "crash-looping",
  severity: "critical",
  since: "2026-01-01T00:00:00.000Z",
  detail: "7 restarts in 10 minutes",
};

const memory: AppCondition = {
  kind: "memory-pressure",
  severity: "warning",
  since: "2026-01-02T00:00:00.000Z",
  detail: "94% of memory limit",
};

describe("conditionRows", () => {
  it("links each condition to the tab that explains it", () => {
    const security: AppCondition = { kind: "security-findings", severity: "critical", since: crashLoop.since, detail: "1 critical" };
    const rows = conditionRows([app("alpha", [security, memory])]);
    expect(rows.map((r) => r.items[0].href)).toEqual(["/apps/alpha/security", "/apps/alpha/metrics"]);
  });

  it("groups apps under one row per problem group", () => {
    const rows = conditionRows([app("alpha", [crashLoop]), app("beta", [crashLoop, memory])]);

    expect(rows.map((r) => r.group)).toEqual(["crash", "memory"]);
    expect(rows[0].items.map((i) => i.name)).toEqual(["alpha", "beta"]);
    expect(rows[1].items).toHaveLength(1);
  });

  // Both backup conditions used to read "Backups", the category, as their label.
  it("labels each backup condition precisely instead of by category", () => {
    const missing: AppCondition = { kind: "backup-missing", severity: "warning", since: crashLoop.since, detail: "No backup job covers this app" };
    const never: AppCondition = { kind: "backup-stale", severity: "warning", since: crashLoop.since, detail: "Backup job has never run" };
    const stale: AppCondition = { kind: "backup-stale", severity: "warning", since: crashLoop.since, detail: "Last backup 5 days ago" };
    const [row] = conditionRows([app("alpha", [missing]), app("beta", [never]), app("gamma", [stale])]);

    expect(row.group).toBe("backups");
    expect(row.items.map((i) => i.title)).toEqual(["Not covered by a backup job", "Never backed up", "Overdue"]);
    expect(row.items.every((i) => i.title !== "Backups")).toBe(true);
  });

  it("carries the detail and since of each condition onto its item", () => {
    const [row] = conditionRows([app("alpha", [crashLoop])]);

    expect(row.items[0]).toMatchObject({
      href: "/apps/alpha/stability",
      detail: "7 restarts in 10 minutes",
      since: crashLoop.since,
    });
  });

  it("gives a row the error tone as soon as one app is critical", () => {
    const warningOnly = { ...crashLoop, severity: "warning" as const };
    const rows = conditionRows([app("alpha", [warningOnly]), app("beta", [crashLoop])]);

    expect(rows[0].tone).toBe("error");
  });

  it("keeps a row without a critical app on the warning tone", () => {
    const rows = conditionRows([app("alpha", [memory])]);

    expect(rows[0].tone).toBe("warning");
  });

  it("ignores apps with no conditions", () => {
    expect(conditionRows([{ id: "1", name: "alpha", displayName: "alpha", conditions: null }])).toEqual(
      [],
    );
  });
});

describe("isInlineRow", () => {
  const row = (count: number) => ({
    key: "k",
    label: "Crash loop",
    tone: "error" as const,
    items: Array.from({ length: count }, (_, i) => ({ id: `${i}`, name: `${i}`, href: "/" })),
  });

  it("shows a short row inline", () => {
    expect(isInlineRow(row(1))).toBe(true);
    expect(isInlineRow(row(INLINE_SUBJECT_LIMIT))).toBe(true);
  });

  it("collapses a row past the limit", () => {
    expect(isInlineRow(row(INLINE_SUBJECT_LIMIT + 1))).toBe(false);
  });
});

describe("summarize", () => {
  const row = (
    key: string,
    tone: "error" | "warning" | "neutral" | "activity",
    count: number,
  ): AttentionRow => ({
    key,
    label: key,
    tone,
    items: Array.from({ length: count }, (_, i) => ({
      id: `${key}-${i}`,
      name: `${key}-${i}`,
      href: "/",
    })),
  });

  it("drops empty rows and sorts the worst group first", () => {
    const s = summarize([
      row("updates", "neutral", 3),
      row("empty", "error", 0),
      row("memory", "warning", 1),
      row("down", "error", 1),
    ]);
    expect(s.groups.map((g) => g.key)).toEqual(["down", "memory"]);
    expect(s.info.map((r) => r.key)).toEqual(["updates"]);
    expect(s.worst).toBe("error");
  });

  // An available update is a fact, not a fault.
  it("leaves informational rows out of the headline count", () => {
    const s = summarize([row("updates", "neutral", 32), row("no-memory-limit", "neutral", 5), row("down", "error", 2)]);
    expect(s.faults).toBe(2);
    expect(s.groups.map((g) => g.key)).toEqual(["down"]);
    expect(s.info.map((r) => r.key)).toEqual(["no-memory-limit", "updates"]);
  });

  it("reports no worst tone and nothing to show when everything is empty", () => {
    const s = summarize([row("empty", "error", 0)]);
    expect(s.groups).toEqual([]);
    expect(s.info).toEqual([]);
    expect(s.worst).toBeNull();
    expect(s.faults).toBe(0);
  });

  // A deploy in progress is not a problem — it must never count as one.
  it("counts faults without counting activity rows", () => {
    const s = summarize([row("deploying", "activity", 2), row("down", "error", 1)]);
    expect(s.faults).toBe(1);
  });

  it("takes the worst tone from the informational rows when nothing is wrong", () => {
    const s = summarize([row("deploying", "activity", 1), row("updates", "neutral", 1)]);
    expect(s.faults).toBe(0);
    expect(s.worst).toBe("neutral");
    expect(s.info.map((r) => r.key)).toEqual(["updates", "deploying"]);
  });

  it("counts an app with problems in two groups once in the headline", () => {
    const s = summarize([
      { key: "a", label: "Crashed", tone: "error", group: "failed", items: [{ id: "x", subject: "app-1", name: "Hub" }] },
      { key: "b", label: "Overdue", tone: "warning", group: "backups", items: [{ id: "y", subject: "app-1", name: "Hub" }] },
    ]);
    expect(s.groups).toHaveLength(2);
    expect(s.faults).toBe(1);
  });
});

describe("groupAttention", () => {
  const app1 = { subject: "app-1", name: "Immich" };
  const app2 = { subject: "app-2", name: "Paperless" };
  const app3 = { subject: "app-3", name: "Outline" };

  // The reported bar: "Backup failed 3 · Backup overdue 2 · Backups 2 · Not backed up 1".
  const backupRows: AttentionRow[] = [
    {
      key: "condition-backups",
      label: "Backups",
      tone: "warning",
      group: "backups",
      items: [
        { id: "c1", ...app1, title: "Overdue", since: "2026-10-05T00:00:00.000Z" },
        { id: "c2", ...app2, title: "Overdue", since: "2026-10-05T00:00:00.000Z" },
      ],
    },
    {
      key: "backup-failed",
      label: "Backup failed",
      tone: "error",
      group: "backups",
      items: [
        { id: "f1", ...app1, since: "2026-10-10T00:00:00.000Z" },
        { id: "f3", ...app3, since: "2026-10-10T00:00:00.000Z" },
      ],
    },
    {
      key: "backup-overdue",
      label: "Overdue",
      tone: "warning",
      group: "backups",
      items: [
        { id: "j1:app-1", ...app1, detail: "Job Media nightly" },
        { id: "j1:app-2", ...app2, detail: "Job Media nightly" },
      ],
    },
    {
      key: "backup-uncovered",
      label: "Not covered by a backup job",
      tone: "warning",
      group: "backups",
      items: [{ id: "u4", subject: "app-4", name: "n8n" }],
    },
  ];

  it("folds every backup source into one group", () => {
    const groups = groupAttention(backupRows);
    expect(groups.map((g) => g.title)).toEqual(["Backups"]);
  });

  it("counts each app once across sources", () => {
    const [group] = groupAttention(backupRows);
    expect(group.items).toHaveLength(4);
    expect(group.items.map((i) => i.subject).sort()).toEqual(["app-1", "app-2", "app-3", "app-4"]);
  });

  it("leads with the worst report for an app and notes the rest", () => {
    const [group] = groupAttention(backupRows);
    const immich = group.items.find((i) => i.subject === "app-1")!;
    expect(immich).toMatchObject({ title: "Backup failed", tone: "error", also: ["Overdue"] });
  });

  it("keeps precise, distinct labels per item", () => {
    const [group] = groupAttention(backupRows);
    expect(Object.fromEntries(group.items.map((i) => [i.name, i.title]))).toEqual({
      Immich: "Backup failed",
      Outline: "Backup failed",
      Paperless: "Overdue",
      n8n: "Not covered by a backup job",
    });
  });

  it("colors the group by its worst item and lists errors first", () => {
    const [group] = groupAttention(backupRows);
    expect(group.tone).toBe("error");
    expect(group.items.slice(0, 2).map((i) => i.tone)).toEqual(["error", "error"]);
  });

  it("sorts groups worst first, then by the Projects group order", () => {
    const groups = groupAttention([
      { key: "e", label: "Errors up", tone: "warning", group: "errors", items: [{ id: "e1", name: "api" }] },
      { key: "b", label: "Overdue", tone: "warning", group: "backups", items: [{ id: "b1", name: "db" }] },
      { key: "m", label: "No container", tone: "warning", group: "missing", items: [{ id: "m1", name: "web" }] },
      { key: "c", label: "Certificate expired", tone: "error", group: "certs", items: [{ id: "c1", name: "site" }] },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["certs", "missing", "errors", "backups"]);
  });

  it("files an item under its own group when it overrides the row's", () => {
    const groups = groupAttention([
      {
        key: "app-down",
        label: "App down",
        tone: "error",
        group: "failed",
        items: [
          { id: "a", name: "api", title: "Crashed" },
          { id: "b", name: "web", title: "No container", group: "missing", tone: "warning" },
        ],
      },
    ]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.title)])).toEqual([
      ["Failed or crashed", ["Crashed"]],
      ["No container", ["No container"]],
    ]);
  });
});

describe("mergeAttentionRows", () => {
  const instanceRow: AttentionRow = {
    key: "vardo-self-deploy",
    label: "Vardo updating",
    tone: "activity",
    items: [{ id: "deploy-1", name: "Vardo" }],
  };

  it("puts instance rows ahead of the org's", () => {
    const orgRow: AttentionRow = {
      key: "deploying",
      label: "Deploying",
      tone: "activity",
      items: [{ id: "deploy-2", name: "Blog" }],
    };

    expect(mergeAttentionRows([instanceRow], [orgRow]).map((r) => r.key)).toEqual([
      "vardo-self-deploy",
      "deploying",
    ]);
  });

  // One self-deploy is one row, whichever org the viewer is scoped to.
  it("drops an org subject the instance already reported", () => {
    const orgRow: AttentionRow = {
      key: "deploying",
      label: "Deploying",
      tone: "activity",
      items: [
        { id: "deploy-1", name: "Vardo" },
        { id: "deploy-2", name: "Blog" },
      ],
    };

    const merged = mergeAttentionRows([instanceRow], [orgRow]);
    expect(merged.flatMap((r) => r.items.map((i) => i.id))).toEqual(["deploy-1", "deploy-2"]);
  });

  it("drops an org row left with nothing to say", () => {
    const orgRow: AttentionRow = {
      key: "deploying",
      label: "Deploying",
      tone: "activity",
      items: [{ id: "deploy-1", name: "Vardo" }],
    };

    expect(mergeAttentionRows([instanceRow], [orgRow])).toEqual([instanceRow]);
  });

  it("renders nothing when both sources are quiet", () => {
    expect(mergeAttentionRows([], [])).toEqual([]);
  });
});

describe("announceAttention", () => {
  it("says nothing about a healthy instance", () => {
    expect(announceAttention([])).toBe("");
  });

  it("names the row and its subjects", () => {
    expect(
      announceAttention([
        {
          key: "core-service-down",
          label: "Core service down",
          tone: "error",
          items: [{ id: "loki", name: "Loki" }],
        },
      ]),
    ).toBe("Core service down: Loki.");
  });
});

describe("attention panel keys", () => {
  it("round-trips a group through ?panel=", () => {
    expect(attentionPanelGroup(attentionPanelKey("backups"))).toBe("backups");
  });

  // The Projects page's own panels share the parameter and must not open this one.
  it("ignores another page's panel", () => {
    expect(attentionPanelGroup("backups")).toBeNull();
    expect(attentionPanelGroup("attention")).toBeNull();
    expect(attentionPanelGroup(null)).toBeNull();
  });
});
