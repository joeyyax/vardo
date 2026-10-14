import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeployProgress, deploySteps, stagesUpTo, WaitWhy } from "@/components/deploy-progress";
import { deployView, NO_WAIT } from "@/lib/ui/deploy-wait";

type Props = Parameters<typeof DeployProgress>[0];

const render = (props: Partial<Omit<Props, "row">> & { row?: Partial<Props["row"]> }) =>
  renderToStaticMarkup(
    createElement(DeployProgress, {
      variant: "full",
      stages: {},
      wait: NO_WAIT,
      typicalMs: 277_000,
      log: ["[queue] Waiting for the worker. Deploys start when it's back"],
      ...props,
      row: { status: "queued", startedAt: Date.now() - 60_000, ...props.row },
    }),
  );

const named = (html: string) => [...html.matchAll(/<span(?: title="[^"]*")?>([^<]+)<\/span><span class="sr-only">/g)].map((m) => m[1]);

describe("DeployProgress", () => {
  it("shows a queued deploy as queued, never deploying, with no actions of its own", () => {
    const html = render({});
    expect(html).toContain("Queued");
    expect(html).not.toContain("Deploying");
    expect(html).not.toContain("Waiting");
    expect(html).not.toMatch(/Cancel|Abort/);
  });

  it("names a held request as preparing", () => {
    expect(render({ row: { held: true } })).toContain("Preparing");
  });

  it("ticks off the queued step once a phase runs", () => {
    const html = render({ stages: { clone: "running" }, row: { status: "running" } });
    expect(html).toMatch(/Queued<\/span><span class="sr-only">, done/);
    expect(html).toMatch(/Clone<\/span><span class="sr-only">, in progress/);
  });

  it("reads a claimed deploy with no phase yet as starting", () => {
    const html = render({ row: { status: "running", stage: null } });
    expect(html).toMatch(/Starting<\/span><span class="sr-only">, in progress/);
  });

  it("names every phase in full but only the one in flight in compact", () => {
    const stages = { clone: "success", compose: "success", build: "running" };
    const full = named(render({ stages, row: { status: "running" } }));
    const compact = named(render({ variant: "compact", stages, row: { status: "running" }, href: "/apps/x/deployments/d" }));
    expect(full).toEqual(["Queued", "Clone", "Compose", "Build", "Deploy", "Health", "Route"]);
    expect(compact).toEqual(["Build"]);
  });

  it("announces the place in line, never the countdown", () => {
    const wait = { ...NO_WAIT, heard: true, current: { reason: "deploy-slot" as const, ahead: 2, total: 5, eta: Date.now() + 360_000, since: Date.now() - 60_000 } };
    const live = /aria-live="polite"[^>]*>([^<]*)</.exec(render({ wait }))?.[1];
    expect(live).toBe("3rd in line");
  });

  it("puts a plain queued wait's reason in reach of the keyboard", () => {
    const html = renderToStaticMarkup(createElement(WaitWhy, { why: "Another deploy of this app is using its checkout" }, "Queued"));
    const id = /<span tabindex="0" aria-describedby="([^"]+)"[^>]*>Queued<\/span>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<span hidden="" id="${id}">Another deploy of this app is using its checkout</span>`);
    expect(renderToStaticMarkup(createElement(WaitWhy, {}, "Deploying"))).toBe("<span>Deploying</span>");
  });

  it("links compact to the deploy and keeps the log and time spent to full", () => {
    const compact = render({ variant: "compact", stages: { clone: "running" }, row: { status: "running" }, href: "/apps/x/deployments/d" });
    expect(compact).toContain("Open →");
    expect(compact).not.toContain("deploy log");
    const full = render({ stages: { clone: "running" }, row: { status: "running" }, onToggleExpand: () => {} });
    expect(full).not.toContain("Open →");
    expect(full).toContain("Show deploy log");
  });
});

describe("deploySteps", () => {
  it("leaves cleanup and skipped phases out", () => {
    const view = deployView({ queued: false, wait: null, started: true });
    const keys = deploySteps(view, { clone: "success", compose: "skipped", build: "running" }).map((s) => s.key);
    expect(keys).toEqual(["queued", "clone", "build", "deploy", "healthcheck", "routing"]);
  });

  it("marks the phase a deploy is held on, and drops the queued step from a rollback", () => {
    const held = deployView({ queued: false, wait: { reason: "build-slot", ahead: 1 }, started: true });
    expect(deploySteps(held, { clone: "success", compose: "success", build: "running" }).find((s) => s.key === "build")?.state).toBe("held");
    const rollback = deployView({ queued: false, wait: null, started: true });
    expect(deploySteps(rollback, { stop: "running" })[0].key).toBe("stop");
  });
});

describe("stagesUpTo", () => {
  it("fills in the phases a row's stage implies until the stream replays", () => {
    expect(stagesUpTo("build")).toEqual({ clone: "success", compose: "success", build: "running" });
    expect(stagesUpTo("restore")).toEqual({ stop: "success", restore: "running" });
    expect(stagesUpTo(null)).toEqual({});
  });

  it("shows a running row's phase before its stream connects", () => {
    const html = render({ row: { status: "running", stage: "deploy" } });
    expect(html).toMatch(/Build<\/span><span class="sr-only">, done/);
    expect(html).toMatch(/Deploy<\/span><span class="sr-only">, in progress/);
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
