import { describe, it, expect } from "vitest";
import { subjectHref } from "@/lib/activity/subject-href";
import type { ActivityFamily } from "@/lib/activity/types";

const app = { id: "a1", name: "web", displayName: "Web" };

function item(action: string, family: ActivityFamily, metadata: unknown = {}, withApp = true) {
  return { action, family, metadata, app: withApp ? app : null };
}

describe("subjectHref", () => {
  it("opens the deploy itself when the row names one", () => {
    expect(subjectHref(item("deployment.failed", "deploy", { deploymentId: "d1" }))).toBe("/apps/web/deployments/d1");
  });

  it("falls back to the tab the action concerns", () => {
    expect(subjectHref(item("deployment.started", "deploy"))).toBe("/apps/web/deployments");
    expect(subjectHref(item("backup.failed", "backup"))).toBe("/apps/web/backups");
    expect(subjectHref(item("cron.failed", "cron"))).toBe("/apps/web/cron");
    expect(subjectHref(item("domain.added", "domain"))).toBe("/apps/web/networking");
    expect(subjectHref(item("security.scan_completed", "security"))).toBe("/apps/web/security");
    expect(subjectHref(item("app.crashed", "app"))).toBe("/apps/web/stability");
  });

  it("goes to the app page for anything else", () => {
    expect(subjectHref(item("app.updated", "app"))).toBe("/apps/web");
  });

  it("links nothing once the app is gone", () => {
    expect(subjectHref(item("app.deleted", "app", { name: "web" }, false))).toBeNull();
  });
});
