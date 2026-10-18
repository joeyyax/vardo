import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeployProgress, deploySteps, stagesUpTo, startNextConsequence } from "@/components/deploy-progress";
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
    expect(html).toMatch(/Prepare<\/span><span class="sr-only">, in progress/);
  });

  it("reads a claimed deploy with no phase yet as starting", () => {
    const html = render({ row: { status: "running", stage: null } });
    expect(html).toMatch(/Starting<\/span><span class="sr-only">, in progress/);
  });

  it("names every phase in full but only the one in flight in compact", () => {
    const stages = { clone: "success", compose: "success", build: "running" };
    const full = named(render({ stages, row: { status: "running" } }));
    const compact = named(render({ variant: "compact", stages, row: { status: "running" }, href: "/apps/x/deployments/d" }));
    expect(full).toEqual(["Queued", "Prepare", "Build", "Start", "Health check", "Switch traffic"]);
    expect(compact).toEqual(["Build"]);
  });

  it("announces the place in line, never the countdown", () => {
    const wait = { ...NO_WAIT, heard: true, current: { reason: "deploy-slot" as const, ahead: 2, total: 5, eta: Date.now() + 360_000, since: Date.now() - 60_000 } };
    const live = /aria-live="polite"[^>]*>([^<]*)</.exec(render({ wait }))?.[1];
    expect(live).toBe("3rd in line");
  });

  it("names each compact Open link's deploy to a screen reader", () => {
    const html = render({ variant: "compact", stages: { clone: "running" }, row: { status: "running" }, href: "/apps/x/deployments/d", subject: "Queued app" });
    expect(html).toContain('Open →<span class="sr-only"> deploy of Queued app</span>');
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
    expect(keys).toEqual(["queued", "prepare", "build", "deploy", "healthcheck", "routing"]);
  });

  it("reads clone and compose as one Prepare step, in flight until both are done", () => {
    const view = deployView({ queued: false, wait: null, started: true });
    const prep = (stages: Record<string, string>) => deploySteps(view, stages).filter((s) => s.label === "Prepare");
    expect(prep({ clone: "success", compose: "running" })).toEqual([{ key: "prepare", label: "Prepare", state: "now" }]);
    expect(prep({ clone: "success", compose: "success", build: "running" })[0].state).toBe("done");
    expect(prep({ clone: "success", compose: "failed" })[0].state).toBe("failed");
  });

  it("names a build held for the builder as waiting for a builder", () => {
    const held = deployView({ queued: false, wait: { reason: "build-slot", ahead: 1 }, started: true });
    const build = deploySteps(held, { clone: "success", compose: "success", build: "running" }).find((s) => s.key === "build");
    expect(build).toMatchObject({ state: "held", label: "Waiting for a builder" });
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
    expect(html).toMatch(/Start<\/span><span class="sr-only">, in progress/);
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

describe("startNextConsequence", () => {
  it("counts the deploys it jumps", () => {
    expect(startNextConsequence(2)).toBe("It starts before the 2 deploys ahead of it.");
    expect(startNextConsequence(1)).toBe("It starts before the deploy ahead of it.");
  });
});
