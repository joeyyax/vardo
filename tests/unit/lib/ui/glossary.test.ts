import { describe, it, expect } from "vitest";
import { appStatusEnum } from "@/lib/db/schema/enums";
import { BACKUP_NEVER_RAN_DETAIL, type AppCondition, type ConditionKind } from "@/lib/docker/conditions";
import { PROBLEM_GROUP_ORDER, PROBLEM_GROUPS, conditionProblem, problem } from "@/lib/ui/conditions";
import {
  APP_STATUS_TERM,
  CONDITION_TERM,
  GLOSSARY,
  GLOSSARY_IDS,
  PROBLEM_GROUP_TERM,
  STATUS_MARK_TERM,
  attentionGroupTerm,
  conditionTerm,
  glossaryHref,
  isGlossaryId,
  termForText,
} from "@/lib/ui/glossary";
import { statusMarkTone } from "@/lib/ui/status-colors";

// Typecheck fails when a kind is added without listing it here.
const KINDS = {
  "crash-looping": true,
  unhealthy: true,
  "self-heal-exhausted": true,
  "memory-pressure": true,
  "security-findings": true,
  "backup-missing": true,
  "backup-stale": true,
  "cert-expiring": true,
  "cert-expired": true,
} satisfies Record<ConditionKind, true>;

const condition = (kind: ConditionKind, detail = "detail"): AppCondition => ({
  kind,
  severity: "critical",
  since: "2026-01-01T00:00:00.000Z",
  detail: kind === "memory-pressure" ? "92% of 512 MB" : detail,
});

describe("glossary entries", () => {
  it.each(GLOSSARY_IDS)("%s is short and plain", (id) => {
    const e = GLOSSARY[id];
    expect(e.term.trim()).not.toBe("");
    expect(e.what.length).toBeLessThanOrEqual(200);
    expect(e.label?.length ?? 0).toBeLessThanOrEqual(40);
    expect(e.what).toMatch(/\.$/);
    expect(e.what).not.toMatch(/\b(just|simply|easily|obviously|actually|please|basically|note that)\b/i);
    expect(e.what).not.toMatch(/\b(do not|cannot|does not|is not|will not)\b/);
    expect(e.what).not.toMatch(/, [^,.]{1,40}, (and|or) /);
  });

  it("links to an anchor on the docs glossary page", () => {
    expect(glossaryHref("missing")).toBe("https://vardo.run/docs/glossary#no-container");
    expect(glossaryHref("running")).toBeNull();
    for (const id of GLOSSARY_IDS) {
      const slug = GLOSSARY[id].docs;
      if (slug) expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("coverage", () => {
  it("has an entry for every app status", () => {
    for (const status of appStatusEnum.enumValues) {
      expect(isGlossaryId(APP_STATUS_TERM[status])).toBe(true);
    }
  });

  it("has an entry for every condition kind", () => {
    for (const kind of Object.keys(KINDS) as ConditionKind[]) {
      expect(isGlossaryId(CONDITION_TERM[kind])).toBe(true);
    }
    expect(conditionTerm({ kind: "backup-stale", detail: BACKUP_NEVER_RAN_DETAIL })).toBe("backup-never");
  });

  it("has an entry for every problem group", () => {
    for (const group of PROBLEM_GROUP_ORDER) {
      expect(isGlossaryId(PROBLEM_GROUP_TERM[group])).toBe(true);
      expect(attentionGroupTerm(group)).toBe(PROBLEM_GROUP_TERM[group]);
    }
  });

  it("explains every condition's problem title", () => {
    for (const kind of Object.keys(KINDS) as ConditionKind[]) {
      const title = conditionProblem("web", condition(kind)).title;
      expect(termForText(title), title).not.toBeNull();
    }
    const never = conditionProblem("web", condition("backup-stale", BACKUP_NEVER_RAN_DETAIL));
    expect(termForText(never.title)).toBe("backup-never");
  });

  it("explains every problem() title", () => {
    const base = { name: "web", status: "active" };
    const titles = [
      problem({ ...base, latestDeploy: { status: "failed", startedAt: new Date() } }),
      problem({ ...base, status: "error" }),
      problem({ ...base, status: "missing" }),
      problem({ ...base, needsRedeploy: true }),
    ].map((p) => p!.title);
    for (const title of titles) expect(termForText(title), title).not.toBeNull();
  });

  it("explains every problem group title", () => {
    for (const group of PROBLEM_GROUP_ORDER) {
      expect(PROBLEM_GROUP_TERM[group], PROBLEM_GROUPS[group].title).toBeTruthy();
    }
  });

  it("explains every status mark label", () => {
    const subjects = [
      { name: "a", status: "active" },
      { name: "a", status: "deploying" },
      { name: "a", status: "stopped" },
      { name: "a", status: "error" },
      { name: "a", status: "missing" },
    ];
    const labels = new Set(subjects.map((s) => statusMarkTone(s).label));
    expect(labels).toEqual(new Set(["Running", "Deploying", "Stopped", "Failed", "Needs attention"]));
    for (const label of labels) expect(isGlossaryId(STATUS_MARK_TERM[label])).toBe(true);
  });

  it("covers the asked-for vocabulary", () => {
    const required = [
      "parked", "self-heal-exhausted", "backup-paused", "restore-drill", "retention", "bind-mount", "volume",
      "phase-clone", "phase-build", "phase-start", "health-check", "rollback", "blue-green", "cutover",
      "memory-limit", "cpu-limit", "profile-fixed", "profile-burstable", "profile-auto", "anomaly",
      "image-update", "security-findings", "severity-critical", "severity-warning", "severity-info",
      "certificate", "canary", "follower", "mesh", "update-off", "update-notify", "update-auto",
      "delivery-immediate", "delivery-batch", "delivery-digest", "trusted-org", "service-kind",
    ];
    for (const id of required) expect(isGlossaryId(id), id).toBe(true);
  });

  it("reads memory titles and leaves ambiguous words alone", () => {
    expect(termForText("Memory at 92%")).toBe("memory-pressure");
    expect(termForText("Auto")).toBeNull();
    expect(termForText("Something new")).toBeNull();
  });
});
