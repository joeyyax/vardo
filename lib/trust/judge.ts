// Turns what each source reports into a check state and one line of evidence. Pure.
// A check that can't be verified is unknown, never passing.

import type { Judgement } from "./types";

const DAY_MS = 86_400_000;
export const RESTORE_TEST_WINDOW_MS = 7 * DAY_MS;
/** Floor under "last night": a nightly job started 02:00 and read at noon is still last night's. */
export const NIGHTLY_WINDOW_MS = 26 * 60 * 60_000;

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Passing when all are good, failing when none are, partial between. */
function tally(good: number, total: number): "passing" | "partial" | "failing" {
  if (good === total) return "passing";
  return good === 0 ? "failing" : "partial";
}

export function judgeSecurityContact(contact: string): Judgement {
  if (contact.trim()) return { state: "passing", evidence: `Reports go to ${contact.trim()}.` };
  return { state: "failing", evidence: "No security contact is set." };
}

export type DomainTls = {
  domain: string;
  tls: "valid" | "invalid" | "unreachable" | "no-https";
  expiresAt: Date | null;
};

export function judgeHttps(domains: DomainTls[]): Judgement {
  if (domains.length === 0) return { state: "unknown", evidence: "No public domains to check." };
  const valid = domains.filter((d) => d.tls === "valid");
  const bad = domains.filter((d) => d.tls === "invalid" || d.tls === "no-https");
  const unreachable = domains.length - valid.length - bad.length;
  const soonest = valid.map((d) => d.expiresAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
  const head = `${valid.length} of ${domains.length} valid`;
  if (bad.length === 0 && unreachable === 0) {
    return { state: "passing", evidence: soonest ? `${head}. Soonest expiry ${shortDate(soonest)}.` : `${head}.` };
  }
  if (bad.length === 0) {
    return { state: "unknown", evidence: `${head}. ${count(unreachable, "domain")} didn't answer on port 443.` };
  }
  const names = bad.slice(0, 2).map((d) => d.domain).join(", ");
  const more = bad.length > 2 ? ` and ${bad.length - 2} more` : "";
  return { state: tally(valid.length, domains.length), evidence: `${head}. Invalid or missing: ${names}${more}.` };
}

export type JobRun = { status: string; startedAt: Date };
export type NightlyJob = { name: string; enabled: boolean; intervalMs: number | null; runs: JobRun[] };

const NO_JOBS = "No backup jobs are enabled.";

export function judgeNightlyBackups(jobs: NightlyJob[], now: Date): Judgement {
  const enabled = jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return { state: "failing", evidence: NO_JOBS, fix: "Set up nightly backups" };
  let ok = 0;
  let failed = 0;
  let missing = 0;
  for (const job of enabled) {
    const window = Math.max(NIGHTLY_WINDOW_MS, (job.intervalMs ?? 0) * 1.1);
    const recent = job.runs.filter((r) => now.getTime() - r.startedAt.getTime() <= window);
    if (recent.some((r) => r.status === "failed")) failed++;
    else if (recent.some((r) => r.status === "success")) ok++;
    else missing++;
  }
  if (ok === enabled.length) return { state: "passing", evidence: `${ok} of ${enabled.length} backup jobs succeeded in their last run.` };
  const parts = [failed ? `${failed} failed` : "", missing ? `${missing} had no run` : ""].filter(Boolean).join(", ");
  return { state: tally(ok, enabled.length), evidence: `${ok} of ${enabled.length} backup jobs succeeded. ${parts}.` };
}

export type JobProtection = {
  name: string;
  enabled: boolean;
  /** The job's newest successful archive and its target. Null before the first success. */
  latest: { encrypted: boolean; offHost: boolean } | null;
};

export function judgeBackupsProtected(jobs: JobProtection[]): Judgement {
  const enabled = jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return { state: "failing", evidence: NO_JOBS, fix: "Back up to encrypted, off-host storage" };
  const withArchive = enabled.filter((j) => j.latest);
  const encrypted = withArchive.filter((j) => j.latest!.encrypted).length;
  const offHost = withArchive.filter((j) => j.latest!.offHost).length;
  const good = withArchive.filter((j) => j.latest!.encrypted && j.latest!.offHost).length;
  const none = enabled.length - withArchive.length;
  if (withArchive.length === 0) return { state: "unknown", evidence: "No backup job has produced an archive yet." };
  const detail = `Encrypted: ${encrypted} of ${withArchive.length}. Off the host: ${offHost} of ${withArchive.length}.`;
  if (good === enabled.length) return { state: "passing", evidence: detail };
  const bad = withArchive.length - good;
  if (bad === 0) return { state: "partial", evidence: `${detail} ${count(none, "job")} without an archive yet.` };
  return { state: tally(good, enabled.length), evidence: detail };
}

export type UpdateReading =
  | { kind: "current"; version: string }
  | { kind: "behind"; version: string; target: string; mode: string }
  | { kind: "unknown"; reason: string };

export function judgeUpdated(reading: UpdateReading): Judgement {
  if (reading.kind === "current") return { state: "passing", evidence: `Running ${reading.version}. Nothing newer on the channel.` };
  if (reading.kind === "behind") {
    return { state: "failing", evidence: `Running ${reading.version}. ${reading.target} is available; updates are ${reading.mode}.` };
  }
  return { state: "unknown", evidence: reading.reason };
}

export type MemberAuth = { twoFactor: boolean; passkeys: number };

export function judgeTwoStep(members: MemberAuth[]): Judgement {
  if (members.length === 0) return { state: "unknown", evidence: "No members to check." };
  const covered = members.filter((m) => m.twoFactor || m.passkeys > 0).length;
  return {
    state: tally(covered, members.length),
    evidence: `${covered} of ${count(members.length, "member")} use a passkey or authenticator app. Sign-in with a password alone isn't blocked.`,
  };
}

export function judgeProbeGuard(input: { apps: number; enabled: number; keyAvailable: boolean }): Judgement {
  if (!input.keyAvailable) return { state: "failing", evidence: "The guard key is unavailable, so Traefik can't tag guarded requests." };
  if (input.apps === 0) return { state: "unknown", evidence: "No apps to guard." };
  const evidence = `On for ${input.enabled} of ${count(input.apps, "app")}.`;
  return { state: tally(input.enabled, input.apps), evidence };
}

export type VolumeDrill = { jobId: string; volumeKey: string; verifiedAt: Date | null; verifyOutcome: string | null };

/** A job is tested when each of its volumes has a verified restore in the window. */
export function judgeRestoreTested(jobs: { id: string; enabled: boolean }[], drills: VolumeDrill[], now: Date): Judgement {
  const enabled = jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return { state: "failing", evidence: NO_JOBS, fix: "Set up backups to restore-test" };
  const tested = enabled.filter((job) => {
    const mine = drills.filter((d) => d.jobId === job.id);
    if (mine.length === 0) return false;
    const volumes = new Set(mine.map((d) => d.volumeKey));
    return [...volumes].every((key) =>
      mine.some(
        (d) =>
          d.volumeKey === key &&
          d.verifyOutcome === "verified" &&
          d.verifiedAt !== null &&
          now.getTime() - d.verifiedAt.getTime() <= RESTORE_TEST_WINDOW_MS,
      ),
    );
  }).length;
  const state = tally(tested, enabled.length);
  const evidence = `${tested} of ${count(enabled.length, "backup job")} had a verified test restore in the last 7 days.`;
  return { state, evidence };
}

