import { describe, it, expect } from "vitest";

import {
  classifyAway,
  reasonFor,
  scoreFor,
  MIN_AWAY_MS,
  ROUTINE_KINDS,
} from "@/lib/away/classify";
import type { AwayBaseline, AwayFact, AwayInput } from "@/lib/away/types";

const NOW = new Date("2026-07-31T20:00:00Z");
const SINCE = new Date("2026-07-29T20:00:00Z");

function fact(overrides: Partial<AwayFact> = {}): AwayFact {
  return {
    kind: "deploy.failed",
    family: "deploy",
    subjectId: "app-1",
    subjectName: "paperless",
    at: new Date("2026-07-30T10:00:00Z"),
    outcome: "failure",
    ...overrides,
  };
}

function input(overrides: Partial<AwayInput> = {}): AwayInput {
  return { since: SINCE, now: NOW, facts: [], baselines: {}, ...overrides };
}

const clean: AwayBaseline = { successes: 40, failures: 0 };
const flaky: AwayBaseline = { successes: 10, failures: 20 };
const mostlyFine: AwayBaseline = { successes: 40, failures: 2 };

describe("reasonFor", () => {
  it("calls a failure with no prior failures a first failure", () => {
    expect(reasonFor(fact(), clean)).toBe("first-failure");
  });

  it("calls a failure with no history at all a first failure", () => {
    expect(reasonFor(fact(), undefined)).toBe("first-failure");
  });

  it("calls an occasional failure a regression", () => {
    expect(reasonFor(fact(), mostlyFine)).toBe("regression");
  });

  it("calls a frequent failure recurring", () => {
    expect(reasonFor(fact(), flaky)).toBe("recurring");
  });

  it("treats an unexplained state change as unexplained regardless of history", () => {
    const f = fact({ kind: "app.down-unexplained", family: "app" });
    expect(reasonFor(f, flaky)).toBe("unexplained");
  });

  it("treats system events as alerts, not failure history", () => {
    const f = fact({ kind: "system.disk-alert", family: "system" });
    expect(reasonFor(f, clean)).toBe("alert");
  });

  it("labels another user's audit entry a change", () => {
    const f = fact({ kind: "app.deleted", family: "org", outcome: "neutral" });
    expect(reasonFor(f, undefined)).toBe("change");
  });

  it("labels an unknown neutral kind unrecognized", () => {
    const f = fact({ kind: "mesh.peer-flapped", family: "app", outcome: "neutral" });
    expect(reasonFor(f, undefined)).toBe("unrecognized");
  });
});

describe("scoreFor", () => {
  it("ranks a first-ever failure above a familiar one", () => {
    const first = scoreFor(fact(), "first-failure", clean);
    const known = scoreFor(fact(), "recurring", flaky);
    expect(first).toBeGreaterThan(known);
  });

  it("ranks a long clean record breaking above a short one", () => {
    const proven = scoreFor(fact(), "first-failure", { successes: 50, failures: 0 });
    const green = scoreFor(fact(), "first-failure", { successes: 1, failures: 0 });
    expect(proven).toBeGreaterThan(green);
  });

  it("lowers the score as prior failures accumulate", () => {
    const twice = scoreFor(fact(), "regression", { successes: 40, failures: 2 });
    const often = scoreFor(fact(), "regression", { successes: 40, failures: 12 });
    expect(often).toBeLessThan(twice);
  });

  it("scores an unknown kind below a recognized failure", () => {
    const unknown = scoreFor(
      fact({ kind: "who.knows", outcome: "neutral" }),
      "unrecognized",
      undefined,
    );
    expect(unknown).toBeLessThan(scoreFor(fact(), "first-failure", clean));
  });
});

describe("classifyAway — tiering", () => {
  it("collapses successful automated work into routine counts", () => {
    const facts = [
      ...Array.from({ length: 14 }, () =>
        fact({ kind: "deploy.success", outcome: "success" }),
      ),
      ...Array.from({ length: 9 }, () =>
        fact({ kind: "backup.success", family: "backup", outcome: "success" }),
      ),
    ];
    const result = classifyAway(input({ facts }));

    expect(result.notable).toHaveLength(0);
    expect(result.routineCount).toBe(23);
    expect(result.routine).toEqual([
      { family: "deploy", count: 14 },
      { family: "backup", count: 9 },
    ]);
  });

  it("puts an unrecognized kind in worth-a-look rather than hiding it", () => {
    const result = classifyAway(
      input({ facts: [fact({ kind: "brand.new-event", outcome: "neutral" })] }),
    );
    expect(result.notable).toHaveLength(1);
    expect(result.notable[0].reason).toBe("unrecognized");
  });

  it("never demotes a failure into routine, however familiar", () => {
    const result = classifyAway(
      input({
        facts: [fact()],
        baselines: { "deploy:app-1": { successes: 1, failures: 99 } },
      }),
    );
    expect(result.notable).toHaveLength(1);
    expect(result.notable[0].reason).toBe("recurring");
    expect(result.routineCount).toBe(0);
  });

  it("keeps a failed kind out of routine even when the kind is allowlisted", () => {
    // Defensive: a collector mislabeling outcome must not manufacture silence.
    expect(ROUTINE_KINDS.has("deploy.success")).toBe(true);
    const result = classifyAway(
      input({ facts: [fact({ kind: "deploy.success", outcome: "failure" })] }),
    );
    expect(result.notable).toHaveLength(1);
  });
});

describe("classifyAway — collapsing and ordering", () => {
  it("collapses repeats of the same kind and subject into one row", () => {
    const facts = [
      fact({ at: new Date("2026-07-30T01:00:00Z") }),
      fact({ at: new Date("2026-07-30T05:00:00Z") }),
      fact({ at: new Date("2026-07-30T09:00:00Z") }),
    ];
    const result = classifyAway(input({ facts }));

    expect(result.notable).toHaveLength(1);
    expect(result.notable[0].count).toBe(3);
    expect(result.notable[0].firstAt).toEqual(new Date("2026-07-30T01:00:00Z"));
    expect(result.notable[0].lastAt).toEqual(new Date("2026-07-30T09:00:00Z"));
  });

  it("does not let in-window repeats raise the score", () => {
    const once = classifyAway(input({ facts: [fact()] })).notable[0].score;
    const many = classifyAway(
      input({ facts: [fact(), fact(), fact(), fact()] }),
    ).notable[0].score;
    expect(many).toBe(once);
  });

  it("keeps different subjects apart", () => {
    const facts = [fact(), fact({ subjectId: "app-2", subjectName: "immich" })];
    expect(classifyAway(input({ facts })).notable).toHaveLength(2);
  });

  it("ranks a first-time failure above a known-flaky one", () => {
    const facts = [
      fact({ subjectId: "flaky-app", subjectName: "flaky" }),
      fact({ subjectId: "solid-app", subjectName: "solid" }),
    ];
    const result = classifyAway(
      input({
        facts,
        baselines: {
          "deploy:flaky-app": flaky,
          "deploy:solid-app": clean,
        },
      }),
    );
    expect(result.notable.map((n) => n.subjectId)).toEqual([
      "solid-app",
      "flaky-app",
    ]);
  });

  it("ranks an unexplained outage above a routine deploy failure", () => {
    const facts = [
      fact(),
      fact({
        kind: "app.down-unexplained",
        family: "app",
        subjectId: "app-2",
        subjectName: "immich",
      }),
    ];
    const result = classifyAway(input({ facts }));
    expect(result.notable[0].kind).toBe("app.down-unexplained");
  });
});

describe("classifyAway — surfacing", () => {
  it("stays hidden when only routine work happened", () => {
    const result = classifyAway(
      input({ facts: [fact({ kind: "deploy.success", outcome: "success" })] }),
    );
    expect(result.shouldSurface).toBe(false);
  });

  it("stays hidden when nothing happened at all", () => {
    expect(classifyAway(input()).shouldSurface).toBe(false);
  });

  it("stays hidden for an absence shorter than the toast gap", () => {
    const now = new Date(SINCE.getTime() + MIN_AWAY_MS - 1);
    const result = classifyAway(input({ now, facts: [fact()] }));
    expect(result.shouldSurface).toBe(false);
  });

  it("surfaces once something needs a look", () => {
    expect(classifyAway(input({ facts: [fact()] })).shouldSurface).toBe(true);
  });

  it("passes unreadable sources through instead of implying completeness", () => {
    const result = classifyAway(
      input({ facts: [fact()], unavailable: ["system-alerts"] }),
    );
    expect(result.unavailable).toEqual(["system-alerts"]);
  });
});
