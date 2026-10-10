import type { AppCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import {
  conditionProblem,
  PROBLEM_GROUP_ORDER,
  PROBLEM_GROUPS,
  type FixAction,
  type ProblemGroup,
} from "@/lib/ui/conditions";
import { exitReasonShort } from "@/lib/ui/exit-reason";
import { conditionUrgent, URGENT_ROW_KEYS } from "@/lib/ui/urgency";

/** "activity" is routine work in progress, not a problem. */
export type AttentionTone = "error" | "warning" | "neutral" | "activity";

/** A fix the bar runs against one app, or a page that handles it. */
export type AttentionFix =
  | { label: string; run: "deploy" | "restart" | "backup"; app: { id: string; name: string } }
  | { label: string; href: string; external?: boolean };

/** A request the item's second button sends without leaving the page. */
export type AttentionPost = { label: string; post: string };

export type AttentionItem = {
  id: string;
  name: string;
  /** Omitted when the viewer has no route to the subject. */
  href?: string;
  detail?: string;
  /** ISO timestamp of first confirmation, rendered as "for 5 hours". */
  since?: string;
  /** Opens in a new tab. */
  external?: boolean;
  /** What the item is about, usually an app id. Defaults to id. */
  subject?: string;
  /** Precise label for this item. Defaults to the row label. */
  title?: string;
  /** Defaults to the row tone. */
  tone?: AttentionTone;
  /** Defaults to the row group. */
  group?: ProblemGroup;
  /** Project, and parent when nested. */
  where?: string;
  /** The project page. */
  whereHref?: string;
  fix?: AttentionFix;
  secondary?: AttentionPost;
  /** Broken right now and needs a person. Set through lib/ui/urgency. */
  urgent?: boolean;
};

/** Serializable; rows cross the API boundary, so no ReactNode. */
export type AttentionRow = {
  key: string;
  label: string;
  tone: AttentionTone;
  items: AttentionItem[];
  /** The problem group the items belong to. Rows without one are informational. */
  group?: ProblemGroup;
  /** What to do about it. */
  footer?: string;
  /** Link to a page that handles the whole row, or a POST it confirms first. */
  action?: AttentionAction;
};

export type AttentionAction =
  | { label: string; href: string }
  | { label: string; post: string; confirm?: { title: string; description: string; label: string } };

const TONE_RANK: Record<AttentionTone, number> = { error: 0, warning: 1, neutral: 2, activity: 3 };

const subjectOf = (item: AttentionItem) => item.subject ?? item.id;

/** Attaches the app a run fix acts on. */
export function attentionFix(
  fix: FixAction | null,
  app: { id: string; name: string },
): AttentionFix | undefined {
  if (!fix) return undefined;
  return "run" in fix ? { ...fix, app: { id: app.id, name: app.name } } : fix;
}

/** Non-empty rows, worst first, subjects alphabetical within each. */
export function presentRows(rows: AttentionRow[]): AttentionRow[] {
  return rows
    .filter((r) => r.items.length > 0)
    .map((r) => ({ ...r, items: [...r.items].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.label.localeCompare(b.label));
}

/** Nothing about an app stopped on purpose is urgent, whichever source reported it. */
export function calmQuietSubjects(rows: AttentionRow[], quiet: ReadonlySet<string>): AttentionRow[] {
  if (quiet.size === 0) return rows;
  return rows.map((row) => ({
    ...row,
    items: row.items.map((item) => (quiet.has(subjectOf(item)) ? { ...item, urgent: false } : item)),
  }));
}

/** Instance rows, then org rows minus subjects the instance already reported. */
export function mergeAttentionRows(
  instanceRows: AttentionRow[],
  orgRows: AttentionRow[],
): AttentionRow[] {
  const claimed = new Set(instanceRows.flatMap((r) => r.items.map(subjectOf)));
  const deduped = orgRows
    .map((row) => ({ ...row, items: row.items.filter((i) => !claimed.has(subjectOf(i))) }))
    .filter((row) => row.items.length > 0);
  return [...instanceRows, ...deduped];
}

// --- Problem groups ----------------------------------------------------------

export type ProblemTone = "error" | "warning";

/** One subject's problem in a group, deduped across every source that reported it. */
export type GroupedItem = {
  subject: string;
  name: string;
  title: string;
  tone: ProblemTone;
  detail?: string;
  since?: string;
  href?: string;
  external?: boolean;
  where?: string;
  whereHref?: string;
  fix?: AttentionFix;
  secondary?: AttentionPost;
  /** Other problems reported for the same subject. */
  also: string[];
  urgent: boolean;
};

export type AttentionGroup = {
  key: string;
  title: string;
  why: string;
  tone: ProblemTone;
  items: GroupedItem[];
};

const isProblemTone = (tone: AttentionTone): tone is ProblemTone =>
  tone === "error" || tone === "warning";

const isProblemRow = (row: AttentionRow) =>
  !!row.group || isProblemTone(row.tone) || row.items.some((i) => !!i.group);

function groupRank(key: string): number {
  const i = PROBLEM_GROUP_ORDER.indexOf(key as ProblemGroup);
  return i === -1 ? PROBLEM_GROUP_ORDER.length : i;
}

const time = (iso?: string) => (iso ? Date.parse(iso) : Infinity);

/** Urgent when its producer said so, or when it is an error on a row that is urgent by kind. */
function isUrgentItem(row: AttentionRow, item: AttentionItem): boolean {
  if (item.urgent !== undefined) return item.urgent;
  return !!URGENT_ROW_KEYS[row.key] && (item.tone ?? row.tone) === "error";
}

/** Problem rows folded into one group per kind and one item per subject, worst group first. */
export function groupAttention(rows: AttentionRow[]): AttentionGroup[] {
  const groups = new Map<string, { meta: { title: string; why: string }; items: Map<string, GroupedItem> }>();

  for (const row of rows.filter(isProblemRow)) {
    for (const item of row.items) {
      const tone = item.tone ?? row.tone;
      if (!isProblemTone(tone)) continue;
      const kind = item.group ?? row.group;
      const key = kind ?? row.key;
      const group = groups.get(key) ?? {
        meta: kind ? PROBLEM_GROUPS[kind] : { title: row.label, why: row.footer ?? "" },
        items: new Map<string, GroupedItem>(),
      };
      groups.set(key, group);

      const next: GroupedItem = {
        subject: subjectOf(item),
        name: item.name,
        title: item.title ?? row.label,
        tone,
        detail: item.detail,
        since: item.since,
        href: item.href,
        external: item.external,
        where: item.where,
        whereHref: item.whereHref,
        fix: item.fix,
        secondary: item.secondary,
        also: [],
        urgent: isUrgentItem(row, item),
      };
      const held = group.items.get(next.subject);
      if (!held) {
        group.items.set(next.subject, next);
        continue;
      }
      // The worse report leads; the other stays as a note.
      const [lead, other] = TONE_RANK[next.tone] < TONE_RANK[held.tone] ? [next, held] : [held, next];
      const also = [...held.also, other.title].filter((t, i, all) => t !== lead.title && all.indexOf(t) === i);
      group.items.set(next.subject, {
        ...lead,
        where: lead.where ?? other.where,
        whereHref: lead.whereHref ?? other.whereHref,
        fix: lead.fix ?? other.fix,
        secondary: lead.secondary ?? other.secondary,
        also,
        urgent: lead.urgent || other.urgent,
      });
    }
  }

  return [...groups.entries()]
    .map(([key, { meta, items }]): AttentionGroup => {
      const sorted = [...items.values()].sort(
        (a, b) =>
          TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
          time(a.since) - time(b.since) ||
          a.name.localeCompare(b.name),
      );
      return {
        key,
        title: meta.title,
        why: meta.why,
        tone: sorted.some((i) => i.tone === "error") ? "error" : "warning",
        items: sorted,
      };
    })
    .filter((g) => g.items.length > 0)
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || groupRank(a.key) - groupRank(b.key));
}

const PANEL_PREFIX = "attention-";

/** What the panel opens on: everything, one group scrolled into view, or the informational rows. */
export type AttentionTarget = "all" | "info" | { group: string };

/** The ?panel= value that opens the panel on a target. */
export function attentionPanelKey(target: AttentionTarget): string {
  return PANEL_PREFIX + (typeof target === "string" ? target : target.group);
}

/** The target a ?panel= value opens, or null when it names another panel. */
export function attentionPanelTarget(panel: string | null): AttentionTarget | null {
  const rest = panel?.startsWith(PANEL_PREFIX) ? panel.slice(PANEL_PREFIX.length) : "";
  if (!rest) return null;
  return rest === "all" || rest === "info" ? rest : { group: rest };
}

/** Whether two targets open the same thing. */
export function sameTarget(a: AttentionTarget | null, b: AttentionTarget | null): boolean {
  if (!a || !b) return a === b;
  return attentionPanelKey(a) === attentionPanelKey(b);
}

export type BarSummary = {
  /** Problems, one group per kind, worst first. */
  groups: AttentionGroup[];
  /** The urgent items of each group. The only thing the global bar shows. */
  urgent: AttentionGroup[];
  /** The rest of each group. The Projects stats carry these. */
  routine: AttentionGroup[];
  /** Updates, inventory and work in progress. Never counted as problems. */
  info: AttentionRow[];
  /** Distinct subjects with a problem. */
  faults: number;
  /** Distinct subjects with an urgent problem. */
  urgentFaults: number;
  /** Distinct subjects with problems, none of them urgent. */
  routineFaults: number;
  worst: AttentionTone | null;
};

function narrow(groups: AttentionGroup[], keep: (i: GroupedItem) => boolean): AttentionGroup[] {
  return groups
    .map((g) => {
      const items = g.items.filter(keep);
      return { ...g, items, tone: items.some((i) => i.tone === "error") ? ("error" as const) : ("warning" as const) };
    })
    .filter((g) => g.items.length > 0);
}

const subjects = (groups: AttentionGroup[]) => new Set(groups.flatMap((g) => g.items.map((i) => i.subject)));

/** Problem groups split into urgent and routine, then the informational rows. */
export function summarize(rows: AttentionRow[]): BarSummary {
  const groups = groupAttention(rows);
  const info = presentRows(rows.filter((r) => !isProblemRow(r)));
  const urgent = narrow(groups, (i) => i.urgent);
  const routine = narrow(groups, (i) => !i.urgent);
  const urgentSubjects = subjects(urgent);
  return {
    groups,
    urgent,
    routine,
    info,
    faults: subjects(groups).size,
    urgentFaults: urgentSubjects.size,
    routineFaults: [...subjects(routine)].filter((s) => !urgentSubjects.has(s)).length,
    worst: groups[0]?.tone ?? info[0]?.tone ?? null,
  };
}

/** The bar renders only for something broken right now. */
export function showsBar(summary: Pick<BarSummary, "urgent">): boolean {
  return summary.urgent.length > 0;
}

/** One sentence per urgent group, for screen readers. Routine changes stay quiet. */
export function announceAttention(rows: AttentionRow[]): string {
  const { urgent } = summarize(rows);
  return urgent
    .map((g) => ({ label: g.title, names: g.items.map((i) => i.name) }))
    .map(({ label, names }) => (names.length ? `${label}: ${names.join(", ")}.` : `${label}.`))
    .join(" ");
}

/** Rows up to this length list their subjects; longer ones collapse. */
export const INLINE_SUBJECT_LIMIT = 5;

export function isInlineRow(row: AttentionRow): boolean {
  return row.items.length <= INLINE_SUBJECT_LIMIT;
}

type ConditionSubject = {
  id: string;
  name: string;
  displayName: string;
  conditions: AppCondition[] | null;
  /** Absent reads as running. */
  status?: string;
  parked?: boolean;
};

/** One row per problem group across the fleet, each item titled by its own condition. */
export function conditionRows(apps: ConditionSubject[]): AttentionRow[] {
  const byGroup = new Map<ProblemGroup, AttentionRow>();

  for (const app of apps) {
    for (const condition of app.conditions ?? []) {
      const p = conditionProblem(app.name, condition);
      const row: AttentionRow = byGroup.get(p.group) ?? {
        key: `condition-${p.group}`,
        label: PROBLEM_GROUPS[p.group].title,
        tone: "warning",
        group: p.group,
        items: [],
      };
      if (p.tone === "error") row.tone = "error";
      row.items.push({
        id: `${app.id}:${condition.kind}`,
        subject: app.id,
        name: app.displayName,
        title: p.title,
        tone: p.tone,
        href: p.look.href,
        detail: p.detail,
        since: condition.since,
        fix: attentionFix(p.fix, app),
        urgent: conditionUrgent(condition, { parked: app.parked, status: app.status ?? "active" }),
      });
      byGroup.set(p.group, row);
    }
  }

  return [...byGroup.values()];
}

type ExitSubject = {
  id: string;
  name: string;
  displayName: string;
  exitReason: ExitReason | null;
};

/** Whether the host OOM killer hit any of these apps within the window. */
export function hadRecentHostOom(apps: ExitSubject[], now: number, windowMs: number): boolean {
  return apps.some(
    (a) => a.exitReason?.kind === "oom-host" && now - Date.parse(a.exitReason.at) <= windowMs,
  );
}

/** OOM-killed apps, split into host-capacity and cgroup-limit rows. Only Docker's OOMKilled counts, never exit 137. */
export function oomRows(apps: ExitSubject[], now: number, windowMs: number): AttentionRow[] {
  const host: AttentionItem[] = [];
  const limit: AttentionItem[] = [];

  for (const app of apps) {
    const reason = app.exitReason;
    if (!reason) continue;
    if (reason.kind !== "oom-host" && reason.kind !== "oom-limit") continue;
    if (now - Date.parse(reason.at) > windowMs) continue;

    (reason.kind === "oom-host" ? host : limit).push({
      id: app.id,
      name: app.displayName,
      href: `/apps/${app.name}`,
      detail: `${reason.containerName} · ${exitReasonShort(reason)}`,
      since: reason.at,
    });
  }

  const rows: AttentionRow[] = [];
  if (host.length > 0) {
    rows.push({
      key: "oom-host",
      label: "Killed for host memory",
      tone: "error",
      group: "failed",
      items: host,
      footer:
        "The host ran out and the kernel chose these. None of them has a memory limit, so nothing bounded what they took.",
      action: { label: "Review host memory", href: "/metrics" },
    });
  }
  if (limit.length > 0) {
    rows.push({
      key: "oom-limit",
      label: "Killed at memory limit",
      tone: "error",
      group: "failed",
      items: limit,
      footer: "These hit their own cgroup limit. Raise it, or find what is using more than it was given.",
    });
  }
  return rows;
}
