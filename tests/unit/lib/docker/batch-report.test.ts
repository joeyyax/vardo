import { describe, it, expect } from "vitest";
import {
  rowKey,
  summarizeBatch,
  type BatchItemResult,
} from "@/lib/docker/image-updates/batch-report";

function item(over: Partial<BatchItemResult> = {}): BatchItemResult {
  return {
    appId: "app1",
    appName: "gitea",
    displayName: "Gitea",
    service: "gitea",
    tag: "1.24",
    ok: true,
    ...over,
  };
}

describe("rowKey", () => {
  it("separates a single-image app from a named service", () => {
    expect(rowKey("app1", null)).toBe("app1:");
    expect(rowKey("app1", "redis")).toBe("app1:redis");
  });
});

describe("summarizeBatch", () => {
  it("counts what landed, not what was sent", () => {
    const report = summarizeBatch([
      item(),
      item({ service: "db", ok: false, error: "No verified update to 18." }),
    ]);
    expect(report.applied).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.total).toBe(2);
  });

  it("names the apps that failed rather than claiming the batch succeeded", () => {
    const report = summarizeBatch([
      item(),
      item({ appId: "app2", appName: "immich", displayName: "Immich", ok: false, error: "Forbidden" }),
    ]);
    expect(report.message).toContain("Pinned 1 of 2");
    expect(report.message).toContain("Immich");
    expect(report.message).not.toContain("Gitea");
  });

  it("surfaces the single error verbatim when nothing landed", () => {
    const report = summarizeBatch([item({ ok: false, error: "Re-run the check first." })]);
    expect(report.message).toBe("Re-run the check first.");
  });

  it("stays generic when several failed and none landed", () => {
    const report = summarizeBatch([
      item({ ok: false, error: "a" }),
      item({ service: "db", ok: false, error: "b" }),
    ]);
    expect(report.message).toBe("None of the 2 updates could be applied.");
  });

  it("reports a clean run without hedging", () => {
    const report = summarizeBatch([item(), item({ service: "db" })]);
    expect(report.message).toBe("Pinned 2 images across 1 app. Deploy to apply.");
  });

  it("groups by app and puts failures first", () => {
    const report = summarizeBatch([
      item({ appId: "a", displayName: "Alpha" }),
      item({ appId: "z", displayName: "Zulu", ok: false, error: "boom" }),
      item({ appId: "a", displayName: "Alpha", service: "db" }),
    ]);
    expect(report.apps.map((a) => a.displayName)).toEqual(["Zulu", "Alpha"]);
    expect(report.apps[1].applied).toBe(2);
    expect(report.apps[0].failed).toHaveLength(1);
  });

  it("falls back to the id when an app could not be resolved", () => {
    const report = summarizeBatch([
      item({ appId: "gone", appName: null, displayName: null, ok: false, error: "Not found" }),
    ]);
    expect(report.apps[0].displayName).toBe("gone");
  });
});
