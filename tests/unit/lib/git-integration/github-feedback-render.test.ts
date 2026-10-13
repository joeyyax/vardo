import { describe, it, expect } from "vitest";
import {
  appPageUrl,
  commitStatusPayload,
  deployPageUrl,
  deploymentPayload,
  deploymentStatusPayload,
  failureText,
  formatDuration,
  mergedMarker,
  overallState,
  previewMarker,
  publicConsoleUrl,
  renderMergedComment,
  renderPreviewComment,
  type ProductionRow,
} from "@/lib/git-integration/github-feedback-render";

const base = { instanceId: "inst-1" };
const SHA = "3bed1769abcdef";
const LOG = "https://console.example.com/apps/a/deployments/d";
const APP = "https://console.example.com/apps/a";
const TIMEOUT = "docker timed out after 2400s";

describe("renderPreviewComment", () => {
  it.each([
    ["queued", "Preview queued at"],
    ["building", "Preview building at"],
    ["deploying", "Preview deploying at"],
  ] as const)("shows the %s state", (state, heading) => {
    const body = renderPreviewComment({ ...base, sha: "abcdef1234567", rows: [{ app: "web", state }] });
    expect(body.startsWith(previewMarker("inst-1"))).toBe(true);
    expect(body).toContain(`**${heading} \`abcdef1\`**`);
    expect(body).not.toContain("https://");
  });

  it("lists only a URL per service when all are live", () => {
    const body = renderPreviewComment({
      ...base,
      sha: "abcdef1234567",
      rows: [
        { app: "web", state: "live", url: "https://pr-4-web.example.com" },
        { app: "api", state: "live", url: "https://pr-4-api.example.com" },
      ],
    });
    expect(body).toBe([
      previewMarker("inst-1"),
      "**Preview live at `abcdef1`**",
      "",
      "| Service | URL |",
      "| --- | --- |",
      "| api | https://pr-4-api.example.com |",
      "| web | https://pr-4-web.example.com |",
    ].join("\n"));
  });

  it("gives a failed row its own error and links next to a live row", () => {
    const body = renderPreviewComment({
      ...base,
      rows: [
        { app: "web", state: "live", url: "https://pr-4-web.example.com" },
        { app: "api", state: "failed", error: "build exited 1 | oops\nmore", logUrl: LOG, appUrl: APP },
      ],
    });
    expect(body).toContain("**Preview failed**");
    expect(body).toContain(`| api | Failed · build exited 1 \\| oops | [Log](${LOG}) · [Open in Vardo](${APP}) |`);
    expect(body).toContain("| web | Live · https://pr-4-web.example.com |  |");
  });

  it("drops the links column when there is no public console", () => {
    const body = renderPreviewComment({ ...base, rows: [{ app: "api", state: "failed", error: "boom" }, { app: "web", state: "building" }] });
    expect(body).toContain("| Service | Status |\n");
    expect(body).toContain("| api | Failed · boom |");
    expect(body).not.toContain("[Log]");
  });

  it("states a shared error once", () => {
    const body = renderPreviewComment({
      ...base,
      sha: SHA,
      rows: [
        { app: "web", state: "failed", error: TIMEOUT, logUrl: LOG },
        { app: "api", state: "failed", error: TIMEOUT, logUrl: LOG },
      ],
    });
    expect(body).toContain("**Preview failed at `3bed176`**\n\nThe build took longer than the 40 minute limit.\n\n| Service | Status |  |");
    expect(body).toContain(`| api | Failed | [Log](${LOG}) |`);
  });

  it("says when the preview was removed, in one line", () => {
    const body = renderPreviewComment({ ...base, rows: [{ app: "web", state: "live" }], removed: true });
    expect(body).toBe(`${previewMarker("inst-1")}\n**Preview removed**`);
  });

  it("orders states: failure, then the earliest in flight, then live", () => {
    expect(overallState([{ app: "a", state: "live" }, { app: "b", state: "building" }])).toBe("building");
    expect(overallState([{ app: "a", state: "queued" }, { app: "b", state: "deploying" }])).toBe("queued");
    expect(overallState([{ app: "a", state: "failed" }, { app: "b", state: "building" }])).toBe("failed");
    expect(overallState([{ app: "a", state: "live" }])).toBe("live");
  });

  it("carries no instance name", () => {
    const body = renderPreviewComment({ ...base, rows: [{ app: "web", state: "building" }] });
    expect(body).not.toContain("<sub>");
  });
});

describe("renderMergedComment", () => {
  const failed = (app: string, error: string, over: Partial<ProductionRow> = {}): ProductionRow =>
    ({ app, state: "failed", sha: SHA, error, logUrl: LOG, appUrl: APP, ...over });

  it("reports an all-live deploy with the commit in the heading", () => {
    const body = renderMergedComment({
      ...base,
      rows: [{ app: "web", state: "live", sha: SHA, durationMs: 72_000, url: "https://widget.example.com" }],
    });
    expect(body).toBe([
      mergedMarker("inst-1"),
      "**Live in production at `3bed176`**",
      "",
      "| Service | URL | Duration |",
      "| --- | --- | --- |",
      "| web | https://widget.example.com | 1m 12s |",
    ].join("\n"));
  });

  it("keeps a Version column when the commits differ", () => {
    const body = renderMergedComment({
      ...base,
      rows: [
        { app: "web", state: "live", sha: "1111111aaaa", durationMs: 1000, url: "https://w.example.com" },
        { app: "api", state: "live", sha: "2222222bbbb", durationMs: 2000 },
      ],
    });
    expect(body).toContain("**Live in production**\n");
    expect(body).toContain("| Service | URL | Version | Duration |");
    expect(body).toContain("| api |  | `2222222` | 2s |");
  });

  it("states a shared error once and drops Duration with no live row", () => {
    const body = renderMergedComment({ ...base, rows: [failed("web", TIMEOUT), failed("api", TIMEOUT, { durationMs: 9000 })] });
    expect(body).toBe([
      mergedMarker("inst-1"),
      "**Production deploy failed at `3bed176`**",
      "",
      "The build took longer than the 40 minute limit.",
      "",
      "| Service | Status |  |",
      "| --- | --- | --- |",
      `| api | Failed | [Log](${LOG}) · [Open in Vardo](${APP}) |`,
      `| web | Failed | [Log](${LOG}) · [Open in Vardo](${APP}) |`,
    ].join("\n"));
    expect(body).not.toContain("Duration");
    expect(body).not.toContain("9s");
  });

  it("gives each row its own error when they differ, with Duration for the live one only", () => {
    const body = renderMergedComment({
      ...base,
      rows: [
        failed("api", "docker failed (exit 2): npm ERR! at /srv/app/index.js", { durationMs: 5000 }),
        failed("worker", TIMEOUT),
        { app: "web", state: "live", sha: SHA, durationMs: 72_000, url: "https://widget.example.com" },
      ],
    });
    expect(body).toBe([
      mergedMarker("inst-1"),
      "**Production deploy failed at `3bed176`**",
      "",
      "| Service | Status | Duration |  |",
      "| --- | --- | --- | --- |",
      `| api | Failed · Build failed (exit 2). |  | [Log](${LOG}) · [Open in Vardo](${APP}) |`,
      "| web | Live · https://widget.example.com | 1m 12s |  |",
      `| worker | Failed · The build took longer than the 40 minute limit. |  | [Log](${LOG}) · [Open in Vardo](${APP}) |`,
    ].join("\n"));
    expect(body).not.toContain("npm ERR");
  });

  it("names the commit still serving after a rollback", () => {
    const body = renderMergedComment({
      ...base,
      rows: [{ app: "web", state: "rolled_back", sha: SHA, error: "Rolled back after the deploy", logUrl: LOG, servingSha: "a91c0e2ffff" }],
    });
    expect(body).toContain("**Rolled back in production at `3bed176`**\n\nThe new version stopped soon after going live. `a91c0e2` is still serving traffic.\n");
    expect(body).toContain(`| web | Rolled back | [Log](${LOG}) |`);
  });

  it("leaves the serving sentence out when the restored commit is unknown", () => {
    const body = renderMergedComment({ ...base, rows: [{ app: "web", state: "rolled_back", sha: SHA, error: "Rolled back after the deploy" }] });
    expect(body).toContain("The new version stopped soon after going live.\n");
    expect(body).not.toContain("still serving");
  });

  it("carries no instance name", () => {
    expect(renderMergedComment({ ...base, rows: [failed("web", "x")] })).not.toContain("<sub>");
  });

  it("formats durations", () => {
    expect(formatDuration(4_400)).toBe("4s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(undefined)).toBe("");
  });
});

describe("failureText", () => {
  it("maps a known error and keeps an unknown one's first line, capped", () => {
    expect(failureText("railpack failed (exit 1): secret stderr")).toBe("Build failed (exit 1).");
    expect(failureText("Something odd | here\nstderr line /etc/passwd")).toBe("Something odd \\| here");
    expect(failureText("x".repeat(300))?.length).toBe(100);
    expect(failureText("  ")).toBeNull();
    expect(failureText(null)).toBeNull();
  });
});

describe("payloads", () => {
  it("names the commit status after the app and links the deploy", () => {
    expect(commitStatusPayload({ state: "pending", appName: "widget", description: "Building", targetUrl: "https://console.example.com/apps/a/deployments/d" })).toEqual({
      state: "pending",
      context: "vardo/widget",
      description: "Building",
      target_url: "https://console.example.com/apps/a/deployments/d",
    });
    expect(commitStatusPayload({ state: "success", appName: "widget", description: "ok", targetUrl: null })).not.toHaveProperty("target_url");
  });

  it("scopes deployments to the app and marks previews transient", () => {
    const preview = deploymentPayload({ sha: "abc", appName: "web", prNumber: 4, instanceId: "i", deploymentId: "d" });
    expect(preview).toMatchObject({
      ref: "abc",
      environment: "preview/pr-4/web",
      required_contexts: [],
      auto_merge: false,
      transient_environment: true,
      production_environment: false,
      payload: { vardo: { instance: "i", deployment: "d" } },
    });
    const prod = deploymentPayload({ sha: "abc", appName: "web", instanceId: "i", deploymentId: "d" });
    expect(prod).toMatchObject({ environment: "production/web", production_environment: true, transient_environment: false });
  });

  it("carries environment and log URLs on deployment statuses", () => {
    expect(deploymentStatusPayload({ state: "success", environmentUrl: "https://widget.example.com", logUrl: "https://console.example.com/l" })).toEqual({
      state: "success",
      environment_url: "https://widget.example.com",
      log_url: "https://console.example.com/l",
    });
    expect(deploymentStatusPayload({ state: "inactive" })).toEqual({ state: "inactive" });
  });
});

describe("publicConsoleUrl", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://10.1.2.3",
    "http://192.168.1.2:3000",
    "http://vardo.local",
    "http://vardo",
    "http://[::1]:3000",
    "not a url",
    "",
  ])("drops %s", (raw) => {
    expect(publicConsoleUrl(raw)).toBeNull();
  });

  it("keeps a public origin without a trailing slash", () => {
    expect(publicConsoleUrl("https://console.example.com/")).toBe("https://console.example.com");
    expect(deployPageUrl("https://console.example.com", "app1", "dep1")).toBe("https://console.example.com/apps/app1/deployments/dep1");
    expect(deployPageUrl(null, "app1", "dep1")).toBeNull();
    expect(appPageUrl("https://console.example.com", "app1")).toBe("https://console.example.com/apps/app1");
    expect(appPageUrl(null, "app1")).toBeNull();
  });
});
