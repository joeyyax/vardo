export const VISIBILITIES = ["off", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const BANDS = [
  { band: "basic", label: "Basic", share: 0.25 },
  { band: "good", label: "Good", share: 0.5 },
  { band: "better", label: "Better", share: 0.75 },
  { band: "great", label: "Great", share: 0.9 },
] as const;
export type Band = (typeof BANDS)[number]["band"];

export type CheckState = "passing" | "partial" | "failing" | "unknown";

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
  /** Points the check is worth. The maximum score is the sum across CHECKS. */
  weight: number;
  title: string;
  /** The step that fixes a check that isn't passing. */
  fix: string;
  effort: string;
  href: string;
  action: string;
};

export const CHECKS: CheckDef[] = [
  { id: "security-contact", weight: 5, title: "Security contact set", fix: "Set a security contact", effort: "1 min", href: "#about", action: "Set contact" },
  { id: "https", weight: 15, title: "HTTPS valid on every public domain", fix: "Fix the certificates", effort: "10 min", href: "/admin/settings/domain", action: "Domains" },
  { id: "nightly-backups", weight: 15, title: "Last night's backups succeeded", fix: "Fix the failing backup jobs", effort: "15 min", href: "/backups", action: "Backups" },
  { id: "backups-protected", weight: 10, title: "Backups encrypted and off the host", fix: "Encrypt backups and store them off the host", effort: "15 min", href: "/admin/settings/backup", action: "Backup storage" },
  { id: "vardo-updated", weight: 5, title: "Vardo up to date", fix: "Update Vardo", effort: "5 min", href: "/admin/settings/maintenance", action: "Updates" },
  { id: "two-step", weight: 10, title: "Two-step sign-in for every member", fix: "Ask members to add a passkey or authenticator app", effort: "5 min per member", href: "/admin/users", action: "Users" },
  { id: "probe-guard", weight: 5, title: "Probe guard on", fix: "Turn probe guard on for every app", effort: "2 min", href: "/admin/probe-guard", action: "Probe guard" },
  { id: "restore-tested", weight: 15, title: "Every backup job restore-tested in 7 days", fix: "Restore-test every backup job", effort: "Automatic, within a week", href: "/backups", action: "Backups" },
  { id: "disk-encrypted", weight: 10, title: "Host disk encrypted", fix: "Encrypt the host disk", effort: "Half a day", href: "#hosting", action: "Hosting" },
  { id: "provider-cert", weight: 10, title: "Provider certification covers the location", fix: "Get the provider's audit report for this location", effort: "A few days", href: "#hosting", action: "Hosting" },
];

export type CheckResult = {
  id: CheckId;
  state: CheckState;
  evidence: string;
  fix?: string | null;
  /** Share of the weight earned, 0 to 1. Read for partial results only. */
  credit?: number | null;
  checkedAt: Date | null;
};
/** `fix` is the next-step title for this state, when the check's default doesn't fit. */
export type Judgement = { state: CheckState; evidence: string; fix?: string; credit?: number };

export const RUN_INTERVAL_MS = 15 * 60_000;
