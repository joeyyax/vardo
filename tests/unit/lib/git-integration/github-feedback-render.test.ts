import { describe, it, expect } from "vitest";
import {
  commitStatusPayload,
  deployPageUrl,
  deploymentPayload,
  deploymentStatusPayload,
  formatDuration,
  overallState,
  previewMarker,
  publicConsoleUrl,
  renderMergedComment,
  renderPreviewComment,
} from "@/lib/git-integration/github-feedback-render";

const base = { instanceId: "inst-1", instanceName: "Acme Vardo" };

describe("renderPreviewComment", () => {
  it.each([
    ["queued", "Preview: queued"],
    ["building", "Preview: building"],
    ["deploying", "Preview: deploying"],
  ] as const)("shows the %s state", (state, heading) => {
    const body = renderPreviewComment({ ...base, sha: "abcdef1234567", rows: [{ app: "web", state }] });
    expect(body.startsWith(previewMarker("inst-1"))).toBe(true);
    expect(body).toContain(`**${heading}** at \`abcdef1\``);
    expect(body).not.toContain("https://");
  });

  it("lists a URL per live service", () => {
    const body = renderPreviewComment({
      ...base,
      sha: "abcdef1234567",
      rows: [
        { app: "web", state: "live", url: "https://pr-4-web.example.com" },
        { app: "api", state: "live", url: "https://pr-4-api.example.com" },
      ],
    });
    expect(body).toContain("**Preview: live**");
    expect(body).toContain("| api | Live | https://pr-4-api.example.com |");
    expect(body).toContain("| web | Live | https://pr-4-web.example.com |");
  });

  it("shows a failure's reason and log link", () => {
    const body = renderPreviewComment({
      ...base,
      rows: [
        { app: "web", state: "live", url: "https://pr-4-web.example.com" },
        { app: "api", state: "failed", error: "build exited 1 | oops\nmore", logUrl: "https://console.example.com/apps/a/deployments/d" },
      ],
    });
    expect(body).toContain("**Preview: failed**");
    expect(body).toContain("| api | Failed: build exited 1 \\| oops more ([log](https://console.example.com/apps/a/deployments/d)) |  |");
  });

  it("omits the log link when there is no public console", () => {
    const body = renderPreviewComment({ ...base, rows: [{ app: "api", state: "failed", error: "boom", logUrl: null }] });
    expect(body).toContain("| api | Failed: boom |  |");
    expect(body).not.toContain("[log]");
  });

  it("says when the preview was removed", () => {
    const body = renderPreviewComment({ ...base, rows: [{ app: "web", state: "live" }], removed: true });
    expect(body).toContain("**Preview removed**");
    expect(body).not.toContain("| web |");
  });

  it("orders states: failure, then the earliest in flight, then live", () => {
    expect(overallState([{ app: "a", state: "live" }, { app: "b", state: "building" }])).toBe("building");
    expect(overallState([{ app: "a", state: "queued" }, { app: "b", state: "deploying" }])).toBe("queued");
    expect(overallState([{ app: "a", state: "failed" }, { app: "b", state: "building" }])).toBe("failed");
    expect(overallState([{ app: "a", state: "live" }])).toBe("live");
  });
});

describe("renderMergedComment", () => {
  it("reports a live production deploy with version and duration", () => {
    const body = renderMergedComment({
      ...base,
      rows: [{ app: "web", state: "live", sha: "1234567890", durationMs: 72_000, url: "https://widget.example.com" }],
    });
    expect(body).toContain("**Live in production**");
    expect(body).toContain("| web | [Live](https://widget.example.com) | `1234567` | 1m 12s |");
  });

  it("says when production failed or rolled back", () => {
    const failed = renderMergedComment({ ...base, rows: [{ app: "web", state: "failed", sha: "1234567890", error: "healthcheck", logUrl: "https://console.example.com/x" }] });
    expect(failed).toContain("**Production deploy failed**");
    expect(failed).toContain("Failed: healthcheck ([log](https://console.example.com/x))");
    const rolled = renderMergedComment({ ...base, rows: [{ app: "web", state: "rolled_back", sha: "1234567890" }] });
    expect(rolled).toContain("**Rolled back in production**");
  });

  it("formats durations", () => {
    expect(formatDuration(4_400)).toBe("4s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(undefined)).toBe("");
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
  });
});
