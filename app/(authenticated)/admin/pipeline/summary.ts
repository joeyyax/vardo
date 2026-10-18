// The page's sentence, its status chip and the things a person must act on, from the snapshot.

import { SHARED_STAGE_LABELS, sharedStage } from "@/lib/ui/deploy-stage";
import type { PipelineDeploy, PipelineSnapshot } from "@/lib/pipeline/types";
import { clock, isLive, span, waitsForBuilder } from "./timeline";

export type Tone = "issue" | "warn";
export type AttentionRow = {
  key: string;
  tone: Tone;
  title: string;
  text: string;
  /** The deploy it's about, for Details and Open deploy. */
  deploy?: PipelineDeploy;
  links?: { label: string; href: string }[];
};

/** A failure stays on the attention card this long unless the app deploys again. */
export const FAILURE_ATTENTION_MS = 30 * 60_000;
/** Longer than this with nothing live reads as a long quiet. */
const LONG_QUIET_MS = 60 * 60_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const count = (n: number) => (n === 1 ? "One thing needs" : n === 2 ? "Two things need" : `${n} things need`);

/** Failed or rolled-back deploys from the last half hour whose app hasn't deployed since. */
export function recentFailures(s: PipelineSnapshot): PipelineDeploy[] {
  const all = [...s.deploys, ...s.recent];
  const failed = all.filter(
    (d) => !d.rollback && d.finishedAt !== null && s.at - d.finishedAt < FAILURE_ATTENTION_MS && (d.failed || d.stop === "rolledBack"),
  );
  return failed.filter((f) => !all.some((o) => o.appId === f.appId && o.queuedAt > f.queuedAt && !o.gone));
}

function failedWhere(d: PipelineDeploy): string {
  if (d.stop === "rolledBack") return d.stage === "healthcheck" ? "failed its health check" : "failed after it started";
  const shared = sharedStage(d.stage);
  return shared ? `failed at ${SHARED_STAGE_LABELS[shared].toLowerCase()}` : "failed";
}

/** What a person must act on, worst first. Moving deploys and refusals that fell back aren't on it. */
export function attentionRows(s: PipelineSnapshot): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const d of s.deploys.filter((x) => x.rollback && isLive(x))) {
    rows.push({ key: `rb-${d.id}`, tone: "issue", title: `${d.appName} is rolling back`, text: "It stopped after going live. The previous version is coming back.", deploy: d });
  }
  for (const d of recentFailures(s)) {
    const kept = d.stop === "rolledBack" ? " The old version kept serving." : "";
    rows.push({
      key: `f-${d.id}`,
      tone: "issue",
      title: `${d.appName} ${failedWhere(d)}`,
      text: `${d.failure ? `${d.failure.replace(/\.$/, "")}.` : ""}${kept}`.trim() || `Finished ${span(s.at - d.finishedAt!)} ago.`,
      deploy: d,
    });
  }
  const loops = s.loops.flatMap((g) => g.loops).filter((l) => l.enabled);
  for (const l of loops.filter((x) => x.failed)) {
    rows.push({ key: `lf-${l.name}`, tone: "warn", title: `${l.label} is failing`, text: l.lastError ?? "Its last run failed.", links: [{ label: "This instance", href: "/admin/settings/general" }] });
  }
  if ((s.overdue ?? []).length > 0) {
    const o = s.overdue!;
    const late = loops.find((l) => l.name === "backup-tick" && l.stale);
    const lead = late?.lastTickAt ? `${late.label} last ran ${span(s.at - late.lastTickAt)} ago. ` : "";
    const names = o.length === 1 ? `${o[0].name} last ran ${span(s.at - o[0].at)} ago.` : `${plural(o.length, "job is", "jobs are")} past due.`;
    rows.push({ key: "overdue", tone: "warn", title: "Backups are behind", text: `${lead}${names}`, links: [{ label: "Backups", href: "/backups" }] });
  }
  for (const l of loops.filter((x) => x.stale && !x.failed && !(x.name === "backup-tick" && (s.overdue ?? []).length > 0))) {
    rows.push({
      key: `ls-${l.name}`,
      tone: "warn",
      title: `${l.label} is late`,
      text: l.lastTickAt ? `It last ran ${span(s.at - l.lastTickAt)} ago.` : "It hasn't run yet.",
      links: [{ label: "This instance", href: "/admin/settings/general" }],
    });
  }
  for (const b of s.builders.filter((x) => x.online === false)) {
    rows.push({ key: `off-${b.id}`, tone: "warn", title: `${b.name} is offline`, text: "Builds go to other builders until it's back." });
  }
  return rows;
}

export type Summary = { title: string; text: string; tone: Tone | null };

export function summarize(s: PipelineSnapshot, attention: AttentionRow[]): Summary {
  const live = s.deploys.filter(isLive);
  const moving = live.filter((d) => !d.rollback);
  const others = (n: number) => (n ? `${plural(n, "other deploy is", "other deploys are")} moving.` : "Nothing else is in flight.");

  const rolling = live.find((d) => d.rollback);
  if (rolling) return { title: `${rolling.appName} is rolling back.`, text: `The previous version is coming back. ${others(moving.length)}`, tone: "issue" };
  const failure = recentFailures(s)[0];
  if (failure) {
    const kept = failure.stop === "rolledBack" ? "The old version kept serving. " : "";
    return { title: `${failure.appName} ${failedWhere(failure)}.`, text: `${kept}${others(moving.length)}`, tone: "issue" };
  }

  const tail = attention.length ? ` ${count(attention.length)} you: ${attention.map((a) => a.title.charAt(0).toLowerCase() + a.title.slice(1)).join("; ")}.` : "";
  if (live.length > 0) {
    const waiting = live.filter(waitsForBuilder);
    const queued = live.filter((d) => d.stop === "queue");
    const title = `${plural(live.length, "deploy", "deploys")} in flight.${waiting.length ? ` ${waiting.length} ${waiting.length === 1 ? "is" : "are"} waiting for a builder.` : ""}`;
    const soonest = waiting.map((d) => d.next).filter((n) => n !== null).sort((a, b) => a!.at - b!.at)[0];
    const text = waiting.length
      ? `Every builder is full${soonest ? `; one should free in about ${span(Math.max(1000, soonest.at - s.at))} on ${soonest.name}` : ""}.`
      : queued.length
        ? `${queued.length} ${queued.length === 1 ? "is" : "are"} queued for a deploy slot.`
        : "Every deploy has a builder.";
    return { title, text: text + tail, tone: attention.length ? "warn" : null };
  }

  const lastLive = s.totals.lastLiveAt ?? s.recent.find((d) => d.status === "success")?.finishedAt ?? null;
  const median = s.totals.medianToLiveMs;
  const day = `${plural(s.totals.live, "deploy", "deploys")} in 24 hours${median ? `, median ${clock(median)} to live` : ""}.`;
  if (lastLive !== null && s.at - lastLive > LONG_QUIET_MS) {
    const hours = Math.floor((s.at - lastLive) / 3_600_000);
    return { title: `Nothing has deployed in ${plural(hours, "hour", "hours")}.`, text: `Builders are idle.${tail}`, tone: attention.length ? "warn" : null };
  }
  const last = s.recent.find((d) => d.status === "success");
  const lead = last?.finishedAt ? `${last.appName} went live ${span(s.at - last.finishedAt)} ago. ` : "";
  return { title: "Nothing in flight.", text: `${lead}${day}${tail}`, tone: attention.length ? "warn" : null };
}

export type HeadChip = { label: string; tone: "issue" | "warn" | "signal" | "neutral" };

export function headChip(s: PipelineSnapshot, attention: AttentionRow[]): HeadChip {
  const live = s.deploys.filter(isLive);
  if (live.some((d) => d.rollback)) return { label: "Rolling back", tone: "issue" };
  if (attention.some((a) => a.tone === "issue")) return { label: "Failed", tone: "issue" };
  if (live.length) return { label: `${live.length} in flight`, tone: "signal" };
  if (attention.length) return { label: "Needs attention", tone: "warn" };
  return { label: "Idle", tone: "neutral" };
}
