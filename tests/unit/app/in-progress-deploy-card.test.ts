import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InProgressDeployCard } from "@/app/(authenticated)/apps/[...slug]/in-progress-deploy-card";

const render = (props: Partial<Parameters<typeof InProgressDeployCard>[0]>) =>
  renderToStaticMarkup(
    createElement(InProgressDeployCard, {
      stages: {},
      log: ["[queue] Waiting for the worker. Deploys start when it's back"],
      startTime: Date.now() - 60_000,
      expanded: false,
      onToggleExpand: () => {},
      onAbort: () => {},
      canAbort: true,
      trigger: "manual",
      ...props,
    }),
  );

describe("InProgressDeployCard", () => {
  it("shows a queued deploy as queued, never deploying", () => {
    const html = render({ queued: true });
    expect(html).toContain("Queued");
    expect(html).toContain("waiting");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Deploying");
    expect(html).not.toContain("Abort");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("in progress");
    expect(html).toMatch(/class="items-center gap-1.5 flex-wrap hidden"/);
  });

  it("shows a running deploy as deploying", () => {
    const html = render({ queued: false, stages: { clone: "running" } });
    expect(html).toContain("Deploying");
    expect(html).toContain("Abort");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("Queued");
  });
});

describe("deploy streams", () => {
  const routes = [
    "app/api/v1/organizations/[orgId]/apps/[appId]/deploy/route.ts",
    "app/api/v1/organizations/[orgId]/apps/[appId]/deploy/stream/route.ts",
    "app/api/v1/organizations/[orgId]/apps/[appId]/rollback/route.ts",
  ];

  it.each(routes)("%s tells the client when a deploy is queued or running", (route) => {
    expect(readFileSync(join(process.cwd(), route), "utf8")).toMatch(/onStatus: \(status\) => sendEvent\("status"/);
  });
});
