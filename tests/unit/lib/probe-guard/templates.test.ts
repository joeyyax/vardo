import { describe, expect, it } from "vitest";
import { blockProblem } from "@/lib/probe-guard/blocks";
import { matchProbe } from "@/lib/probe-guard/rules";
import { DEFAULT_APP_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { PROBE_TEMPLATES } from "@/lib/probe-guard/templates";
import { applyTemplate, removeTemplate } from "@/lib/probe-guard/templates/apply";
import { nextRecommendation } from "@/lib/probe-guard/recommendations";

const phpmyadmin = PROBE_TEMPLATES.find((t) => t.id === "phpmyadmin")!;

describe("templates", () => {
  it("have unique ids and entries the guard accepts", () => {
    expect(new Set(PROBE_TEMPLATES.map((t) => t.id)).size).toBe(PROBE_TEMPLATES.length);
    for (const t of PROBE_TEMPLATES) for (const e of t.turnAway) expect(blockProblem(e), `${t.id} ${e.value}`).toBeNull();
  });

  it("let through only paths a managed rule would otherwise turn away", () => {
    for (const path of phpmyadmin.letThrough ?? []) expect(matchProbe(path)).not.toBeNull();
  });

  it("add their entries once and remove only their own", () => {
    const own = { ...DEFAULT_APP_PROBE_GUARD, exceptions: ["/mine"], blocks: [{ kind: "prefix" as const, value: "/old" }] };
    const added = applyTemplate(applyTemplate(own, phpmyadmin), phpmyadmin);
    expect(added.templates).toEqual(["phpmyadmin"]);
    expect(added.exceptions).toEqual(["/mine", "/phpmyadmin", "/pma"]);
    expect(added.blocks.filter((b) => b.template === "phpmyadmin")).toHaveLength(2);
    expect(removeTemplate(added, phpmyadmin)).toEqual(own);
  });
});

describe("nextRecommendation", () => {
  const row = (status: "pending" | "applied" | "ignored", templateVersion = 1, updated = false) => ({ status, templateVersion, updated });

  it("creates a pending recommendation the first time a scan recognizes a template", () => {
    expect(nextRecommendation(undefined, 1, false)).toEqual({ status: "pending", templateVersion: 1, updated: false });
  });

  it("keeps an ignored recommendation ignored until the template's version changes", () => {
    expect(nextRecommendation(row("ignored"), 1, false)).toBeNull();
    expect(nextRecommendation(row("ignored"), 2, false)).toEqual({ status: "pending", templateVersion: 2, updated: true });
  });

  it("marks an app that already has the template as applied", () => {
    expect(nextRecommendation(row("pending"), 1, true)).toEqual({ status: "applied", templateVersion: 1, updated: false });
    expect(nextRecommendation(row("applied"), 1, true)).toBeNull();
  });

  it("asks again when an owner removes an applied template", () => {
    expect(nextRecommendation(row("applied"), 1, false)).toEqual({ status: "pending", templateVersion: 1, updated: false });
  });
});
