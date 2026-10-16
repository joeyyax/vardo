export const VISIBILITIES = ["off", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const LEVELS = ["basic", "good", "better", "great"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = { basic: "Basic", good: "Good", better: "Better", great: "Great" };

export const CHECK_STATES = ["passing", "partial", "failing", "unknown"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const CHECK_IDS = [
  "security-contact",
  "https",
  "nightly-backups",
  "backups-protected",
  "vardo-updated",
  "two-step",
  "probe-guard",
  "restore-tested",
  "disk-encrypted",
  "provider-cert",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type CheckDef = {
  id: CheckId;
  level: Level;
  title: string;
  /** The step that fixes a check that isn't passing. */
  fix: string;
  effort: string;
  href: string;
  action: string;
};

export const CHECKS: CheckDef[] = [
  { id: "security-contact", level: "basic", title: "Security contact set", fix: "Set a security contact", effort: "1 min", href: "#about", action: "Set contact" },
  { id: "https", level: "basic", title: "HTTPS valid on every public domain", fix: "Fix the certificates", effort: "10 min", href: "/admin/settings/domain", action: "Domains" },
  { id: "nightly-backups", level: "good", title: "Last night's backups succeeded", fix: "Fix the failing backup jobs", effort: "15 min", href: "/backups", action: "Backups" },
  { id: "backups-protected", level: "good", title: "Backups encrypted and off the host", fix: "Encrypt backups and store them off the host", effort: "15 min", href: "/admin/settings/backup", action: "Backup storage" },
  { id: "vardo-updated", level: "good", title: "Vardo up to date", fix: "Update Vardo", effort: "5 min", href: "/admin/settings/maintenance", action: "Updates" },
  { id: "two-step", level: "good", title: "Two-step sign-in for every member", fix: "Ask members to add a passkey or authenticator app", effort: "5 min per member", href: "/admin/users", action: "Users" },
  { id: "probe-guard", level: "good", title: "Probe guard on", fix: "Turn probe guard on for every app", effort: "2 min", href: "/admin/probe-guard", action: "Probe guard" },
  { id: "restore-tested", level: "better", title: "Every backup job restore-tested in 7 days", fix: "Restore-test every backup job", effort: "Automatic, within a week", href: "/backups", action: "Backups" },
  { id: "disk-encrypted", level: "better", title: "Host disk encrypted", fix: "Encrypt the host disk", effort: "Half a day", href: "#hosting", action: "Hosting" },
  { id: "provider-cert", level: "great", title: "Provider certification covers the location", fix: "Get the provider's audit report for this location", effort: "A few days", href: "#hosting", action: "Hosting" },
];

export type CheckResult = { id: CheckId; state: CheckState; evidence: string; fix?: string | null; checkedAt: Date | null };
/** `fix` is the next-step title for this state, when the check's default doesn't fit. */
export type Judgement = { state: CheckState; evidence: string; fix?: string };

export const RUN_INTERVAL_MS = 15 * 60_000;
