import { describe, it, expect } from "vitest";
import {
  rollupHealth,
  rollupIsSteady,
  rollupLabel,
  rollupTone,
  type RollupMember,
} from "@/lib/ui/health-rollup";

const app = (status: string, extra: Partial<RollupMember> = {}): RollupMember => ({
  status,
  ...extra,
});

describe("rollupHealth", () => {
  it("counts each status", () => {
    const rollup = rollupHealth([
      app("active"),
      app("active"),
      app("error"),
      app("stopped"),
      app("deploying"),
      app("missing"),
    ]);
    expect(rollup).toMatchObject({
      total: 6,
      active: 2,
      errors: 1,
      stopped: 1,
      deploying: 1,
      missing: 1,
    });
  });

  it("does not count a compose child twice under its project", () => {
    // A project holds the parent and its five services in one flat list.
    const rollup = rollupHealth([
      app("error", { parentAppId: null }),
      app("error", { parentAppId: "parent" }),
      app("error", { parentAppId: "parent" }),
      app("stopped", { parentAppId: "parent" }),
      app("stopped", { parentAppId: "parent" }),
      app("stopped", { parentAppId: "parent" }),
      app("active", { parentAppId: null }),
    ]);
    expect(rollup.total).toBe(2);
    expect(rollup.errors).toBe(1);
    expect(rollup.stopped).toBe(0);
  });

  it("counts every member of a stack, since children arrive without a parent field", () => {
    const rollup = rollupHealth([app("error"), app("error"), app("stopped")]);
    expect(rollup.total).toBe(3);
    expect(rollup.errors).toBe(2);
  });

  it("counts critical tier and members carrying a warning or worse", () => {
    const rollup = rollupHealth([
      app("active", { priority: "critical" }),
      app("active", { priority: "standard" }),
      app("active", {
        conditions: [{ kind: "unhealthy", severity: "warning", since: "", detail: "" }],
      }),
      app("active", {
        conditions: [{ kind: "backup-stale", severity: "info", since: "", detail: "" }],
      }),
    ]);
    expect(rollup.critical).toBe(1);
    expect(rollup.attention).toBe(1);
  });

  it("returns zeros for an empty group", () => {
    expect(rollupHealth([])).toMatchObject({ total: 0, active: 0, errors: 0 });
  });
});

describe("rollupTone", () => {
  it("ranks a crash above everything else", () => {
    const rollup = rollupHealth([app("error"), app("deploying"), app("active")]);
    expect(rollupTone(rollup)).toBe("text-status-error");
  });

  it("reports a deploy in progress over a partial roll-up", () => {
    expect(rollupTone(rollupHealth([app("deploying"), app("active")]))).toBe("text-status-info");
  });

  it("is success only when everything is up", () => {
    expect(rollupTone(rollupHealth([app("active"), app("active")]))).toBe("text-status-success");
    expect(rollupTone(rollupHealth([app("active"), app("stopped")]))).toBe("text-status-warning");
    expect(rollupTone(rollupHealth([app("stopped")]))).toBe("text-status-neutral");
  });

  it("does not call an empty group healthy", () => {
    expect(rollupTone(rollupHealth([]))).toBe("text-status-neutral");
  });
});

describe("rollupLabel", () => {
  it("names the crash count first", () => {
    expect(rollupLabel(rollupHealth([app("error"), app("error"), app("active")]), "service")).toBe(
      "2 crashed",
    );
  });

  it("names the deploy count next", () => {
    expect(rollupLabel(rollupHealth([app("deploying"), app("active")]), "app")).toBe("1 deploying");
  });

  it("falls back to the up-over-total ratio", () => {
    expect(rollupLabel(rollupHealth([app("active"), app("stopped")]), "service")).toBe(
      "1/2 services",
    );
  });

  it("uses the singular for a group of one", () => {
    expect(rollupLabel(rollupHealth([app("active")]), "app")).toBe("1/1 app");
  });

  it("handles an empty group", () => {
    expect(rollupLabel(rollupHealth([]), "app")).toBe("No apps");
  });
});

describe("rollupIsSteady", () => {
  it("is true only when every member is up", () => {
    expect(rollupIsSteady(rollupHealth([app("active"), app("active")]))).toBe(true);
    expect(rollupIsSteady(rollupHealth([app("active"), app("error")]))).toBe(false);
    expect(rollupIsSteady(rollupHealth([]))).toBe(false);
  });
});
