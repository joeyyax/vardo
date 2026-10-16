// What the operator commits to. Three read their value from settings; the rest stay off until the operator sets one.
// Vardo describes a commitment and never makes it: nothing here sets a value for the operator.

export const COMMITMENT_IDS = [
  "recovery-point",
  "backup-retention",
  "security-patches",
  "uptime",
  "recovery-time",
  "breach-notification",
  "maintenance-notice",
  "support-response",
  "data-deletion",
] as const;
export type CommitmentId = (typeof COMMITMENT_IDS)[number];

export type StoredCommitment = { enabled?: boolean; amount?: number | null };
export type StoredCommitments = Partial<Record<CommitmentId, StoredCommitment>>;

type Unit = "hours" | "days" | "percent";

type Def = {
  id: CommitmentId;
  label: string;
  help: string;
  /** Read from settings. The operator can switch it off but not set the value. */
  derived: boolean;
  /** Vardo measures this one itself, so the admin view says so. */
  measured: boolean;
  unit: Unit;
  min: number;
  max: number;
  /** What the input suggests before the operator sets a value. */
  hint: string;
  format: (amount: number) => string;
};

function hours(n: number, lead = ""): string {
  const text = n >= 48 && n % 24 === 0 ? `${n / 24} days` : `${n} ${n === 1 ? "hour" : "hours"}`;
  return lead ? `${lead} ${text}` : text;
}

function days(n: number, lead = ""): string {
  const text = `${n} ${n === 1 ? "day" : "days"}`;
  return lead ? `${lead} ${text}` : text;
}

export const COMMITMENTS: Def[] = [
  { id: "recovery-point", label: "Recovery point", help: "The most data a client could lose. Comes from the backup schedule.", derived: true, measured: true, unit: "hours", min: 1, max: 24 * 366, hint: "", format: (n) => hours(n) },
  { id: "backup-retention", label: "Backup retention", help: "How far back a restore can reach. Comes from the backup retention rules.", derived: true, measured: true, unit: "days", min: 1, max: 3660, hint: "", format: (n) => days(n) },
  { id: "security-patches", label: "Security patches", help: "On while automatic updates are on.", derived: true, measured: true, unit: "hours", min: 1, max: 1, hint: "", format: () => "Applied automatically" },
  { id: "uptime", label: "Uptime", help: "Share of time sites respond, per month.", derived: false, measured: false, unit: "percent", min: 90, max: 100, hint: "99.9", format: (n) => `${n}% monthly` },
  { id: "recovery-time", label: "Recovery time", help: "How long until a site is back after a total loss.", derived: false, measured: false, unit: "hours", min: 1, max: 24 * 90, hint: "4", format: (n) => hours(n) },
  { id: "breach-notification", label: "Breach notification", help: "How soon clients hear about a breach.", derived: false, measured: false, unit: "hours", min: 1, max: 24 * 90, hint: "72", format: (n) => hours(n, "Within") },
  { id: "maintenance-notice", label: "Maintenance notice", help: "Warning clients get before planned downtime.", derived: false, measured: false, unit: "hours", min: 1, max: 24 * 90, hint: "48", format: (n) => `${hours(n)} ahead` },
  { id: "support-response", label: "Support response", help: "How quickly a support request gets a reply.", derived: false, measured: false, unit: "hours", min: 1, max: 24 * 90, hint: "24", format: (n) => hours(n, "Within") },
  { id: "data-deletion", label: "Data deletion", help: "How soon client data is deleted after they leave.", derived: false, measured: false, unit: "days", min: 1, max: 3660, hint: "30", format: (n) => days(n, "Within") },
];

export function commitmentDef(id: string): Def | null {
  return COMMITMENTS.find((c) => c.id === id) ?? null;
}

/** What settings say, read from the backup jobs and the update policy. Null when settings don't give a value. */
export type CommitmentFacts = {
  recoveryPointHours: number | null;
  retentionDays: number | null;
  autoUpdate: boolean;
};

export type ResolvedCommitment = {
  id: CommitmentId;
  label: string;
  help: string;
  derived: boolean;
  measured: boolean;
  unit: Unit;
  min: number;
  max: number;
  hint: string;
  /** The operator's switch. Derived commitments start on. */
  enabled: boolean;
  /** The switch can't be turned on: settings don't allow it. */
  locked: boolean;
  /** The number behind the value: from settings, or set by the operator. */
  amount: number | null;
  /** The public text, or null when there's nothing true to say yet. */
  value: string | null;
  /** Why an on switch isn't publishing, for the admin view. */
  blocker: string | null;
};

function derivedAmount(id: CommitmentId, facts: CommitmentFacts): { amount: number | null; blocker: string | null } {
  switch (id) {
    case "recovery-point":
      return facts.recoveryPointHours ? { amount: facts.recoveryPointHours, blocker: null } : { amount: null, blocker: "No enabled backup job has a schedule." };
    case "backup-retention":
      return facts.retentionDays ? { amount: facts.retentionDays, blocker: null } : { amount: null, blocker: "A backup job has no retention rule." };
    case "security-patches":
      return facts.autoUpdate ? { amount: 1, blocker: null } : { amount: null, blocker: "Turn on automatic updates." };
    default:
      return { amount: null, blocker: null };
  }
}

export function validAmount(def: Pick<Def, "min" | "max" | "unit">, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < def.min || amount > def.max) return false;
  return def.unit === "percent" ? Math.round(amount * 100) / 100 === amount : Number.isInteger(amount);
}

export function resolveCommitments(stored: StoredCommitments, facts: CommitmentFacts): ResolvedCommitment[] {
  return COMMITMENTS.map((def) => {
    const s = stored[def.id] ?? {};
    const locked = def.id === "security-patches" && !facts.autoUpdate;
    const enabled = (s.enabled ?? def.derived) && !locked;
    const { amount: fromSettings, blocker: settingsBlocker } = derivedAmount(def.id, facts);
    const amount = def.derived ? fromSettings : s.amount != null && validAmount(def, s.amount) ? s.amount : null;
    const blocker = def.derived ? settingsBlocker : amount === null ? "Set a value to publish it." : null;
    return {
      id: def.id,
      label: def.label,
      help: def.help,
      derived: def.derived,
      measured: def.measured,
      unit: def.unit,
      min: def.min,
      max: def.max,
      hint: def.hint,
      enabled,
      locked,
      amount,
      value: enabled && amount !== null ? def.format(amount) : null,
      blocker,
    };
  });
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The longest gap between runs across the enabled jobs, in whole hours. Null without a schedule to read. */
export function recoveryPointHours(intervalsMs: (number | null)[]): number | null {
  if (intervalsMs.length === 0 || intervalsMs.some((i) => i === null)) return null;
  return Math.max(1, Math.ceil(Math.max(...(intervalsMs as number[])) / HOUR_MS));
}

export type RetentionRule = {
  keepAll: boolean | null;
  keepLast: number | null;
  keepHourly: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  keepYearly: number | null;
  intervalMs: number | null;
};

/** How far back one job restores, or null when it keeps everything or has no rule. */
export function jobRetentionDays(job: RetentionRule): number | null {
  if (job.keepAll) return null;
  const windows = [
    job.keepYearly ? job.keepYearly * 365 : 0,
    job.keepMonthly ? job.keepMonthly * 30 : 0,
    job.keepWeekly ? job.keepWeekly * 7 : 0,
    job.keepDaily ?? 0,
    job.keepHourly ? job.keepHourly / 24 : 0,
    job.keepLast && job.intervalMs ? (job.keepLast * job.intervalMs) / DAY_MS : 0,
  ];
  const days = Math.floor(Math.max(...windows));
  return days >= 1 ? days : null;
}

/** The shortest window across the enabled jobs, so the claim holds for every job. Null when a job has no rule. */
export function retentionDays(jobs: RetentionRule[]): number | null {
  const limited = jobs.filter((j) => !j.keepAll);
  if (limited.length === 0) return null;
  const each = limited.map(jobRetentionDays);
  return each.some((d) => d === null) ? null : Math.min(...(each as number[]));
}
