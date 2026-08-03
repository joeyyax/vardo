import { describe, it, expect } from "vitest";

import {
  APP_ACTIONS,
  appActionMenu,
  type AppAction,
  type AppActionContext,
} from "@/lib/ui/app-actions";

function context(overrides: Partial<AppActionContext> = {}): AppActionContext {
  return {
    status: "active",
    isChildService: false,
    deploying: false,
    standbyAvailable: false,
    hasDeployed: true,
    rollbackTarget: true,
    stopRefusal: null,
    ...overrides,
  };
}

function shown(ctx: AppActionContext): AppAction[] {
  return appActionMenu(ctx).filter((i) => !i.disabled).map((i) => i.action);
}

function disabled(ctx: AppActionContext): AppAction[] {
  return appActionMenu(ctx).filter((i) => i.disabled).map((i) => i.action);
}

function has(ctx: AppActionContext, action: AppAction): boolean {
  return appActionMenu(ctx).some((i) => i.action === action);
}

describe("appActionMenu", () => {
  it("offers the full running menu for an active app", () => {
    expect(shown(context())).toEqual([
      "deploy",
      "restart",
      "recreate",
      "rollback",
      "stop",
    ]);
  });

  it("adds instant rollback only when a standby slot is up", () => {
    expect(shown(context({ standbyAvailable: true }))).toContain("instant-rollback");
    expect(has(context(), "instant-rollback")).toBe(false);
  });

  it("leads with instant rollback on a crashed app", () => {
    expect(shown(context({ status: "error", standbyAvailable: true }))).toEqual([
      "instant-rollback",
      "deploy",
      "restart",
      "recreate",
      "rollback",
      "stop",
    ]);
  });

  it("offers start before the expensive paths for a stopped app", () => {
    expect(shown(context({ status: "stopped" }))).toEqual([
      "start",
      "recreate",
      "deploy",
      "rollback",
    ]);
  });

  it("hides restart, instant rollback and stop for a stopped app", () => {
    const ctx = context({ status: "stopped", standbyAvailable: true });
    for (const action of ["restart", "instant-rollback", "stop"] as const) {
      expect(has(ctx, action)).toBe(false);
    }
  });

  it("makes recreate the primary action for a missing container", () => {
    const ctx = context({ status: "missing" });
    expect(shown(ctx)).toEqual(["recreate", "deploy", "rollback"]);
    expect(has(ctx, "start")).toBe(false);
    expect(has(ctx, "restart")).toBe(false);
  });

  it("disables rollback with a reason when no earlier success exists", () => {
    const ctx = context({ rollbackTarget: false });
    expect(disabled(ctx)).toEqual(["rollback"]);
    expect(appActionMenu(ctx).find((i) => i.action === "rollback")?.disabled).toMatch(
      /roll back to/i,
    );
  });

  it("hides rollback entirely on an app that has never deployed", () => {
    const ctx = context({ status: "active", hasDeployed: false, rollbackTarget: false });
    expect(has(ctx, "rollback")).toBe(false);
  });

  it("offers only deploy on a never-deployed app with no container", () => {
    for (const status of ["stopped", "missing"] as const) {
      expect(appActionMenu(context({ status, hasDeployed: false, rollbackTarget: false })))
        .toEqual([{ action: "deploy" }]);
    }
  });

  it("offers cancel while a deploy is in flight and disables the rest", () => {
    for (const ctx of [context({ deploying: true }), context({ status: "deploying" })]) {
      expect(shown(ctx)).toEqual(["cancel-deploy"]);
      expect(disabled(ctx)).toEqual(["deploy", "restart", "recreate"]);
      expect(has(ctx, "stop")).toBe(false);
      expect(has(ctx, "rollback")).toBe(false);
    }
  });

  it("disables stop with the refusal reason rather than hiding it", () => {
    const reason = "Stopping Vardo would take down the API you need to start it again.";
    const item = appActionMenu(context({ stopRefusal: reason })).find(
      (i) => i.action === "stop",
    );
    expect(item).toEqual({ action: "stop", disabled: reason });
  });

  it("gives a child service restart and logs, never deploy or stop", () => {
    for (const status of ["active", "stopped", "missing", "error"] as const) {
      expect(appActionMenu(context({ status, isChildService: true }))).toEqual([
        { action: "restart" },
        { action: "logs" },
      ]);
    }
  });

  it("returns known, non-duplicated actions for every state", () => {
    const statuses = ["active", "stopped", "missing", "error", "deploying"] as const;
    for (const status of statuses) {
      for (const isChildService of [false, true]) {
        for (const standbyAvailable of [false, true]) {
          for (const hasDeployed of [false, true]) {
            const items = appActionMenu(
              context({ status, isChildService, standbyAvailable, hasDeployed }),
            );
            const actions = items.map((i) => i.action);
            for (const action of actions) expect(APP_ACTIONS).toContain(action);
            expect(new Set(actions).size).toBe(actions.length);
          }
        }
      }
    }
  });
});
