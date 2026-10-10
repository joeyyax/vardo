import { describe, it, expect } from "vitest";

import { applyComposeProfiles, parseComposeProfiles } from "@/lib/docker/compose-profiles";
import { parseCompose } from "@/lib/docker/compose-parse";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";

const compose = () =>
  parseCompose(`
services:
  frontend:
    image: example/frontend
    profiles: [production]
    depends_on: [buildkit, postgres]
  postgres:
    image: postgres:17
  buildkit:
    image: moby/buildkit
    profiles: [buildkit]
`);

describe("applyComposeProfiles", () => {
  it("skips services whose profiles aren't active, and their depends_on entries", () => {
    const { compose: out, skipped } = applyComposeProfiles(compose(), parseComposeProfiles("production"));
    expect(skipped).toEqual(["buildkit"]);
    expect(Object.keys(out.services)).toEqual(["frontend", "postgres"]);
    expect(out.services.frontend.depends_on).toEqual(["postgres"]);
    expect(out.services.frontend.profiles).toBeUndefined();
  });

  it("runs an opted-in profile", () => {
    const { skipped } = applyComposeProfiles(compose(), parseComposeProfiles("production, buildkit"));
    expect(skipped).toEqual([]);
  });

  it("deploys every service without COMPOSE_PROFILES", () => {
    const { compose: out, skipped } = applyComposeProfiles(compose(), parseComposeProfiles(undefined));
    expect(skipped).toEqual([]);
    expect(Object.keys(out.services)).toHaveLength(3);
  });

  it("refuses a deploy that would leave nothing", () => {
    const only = parseCompose("services:\n  a:\n    image: x\n    profiles: [debug]\n");
    expect(() => applyComposeProfiles(only, parseComposeProfiles("production"))).toThrow(/nothing to deploy/);
  });
});

describe("buildVardoOverlay — infrastructure services", () => {
  it("gives them no tier limits, cpu_shares or oom_score_adj", () => {
    const overlay = buildVardoOverlay({
      fullCompose: compose(),
      networkName: "vardo-network",
      infraServices: new Set(["postgres"]),
      hostCpus: 8,
    });
    const { deploy, cpu_shares, oom_score_adj } = overlay.services.postgres;
    expect({ deploy, cpu_shares, oom_score_adj }).toEqual({ deploy: undefined, cpu_shares: undefined, oom_score_adj: undefined });
    expect(overlay.services.frontend.deploy?.resources?.limits).toBeDefined();
    expect(overlay.services.frontend.cpu_shares).toBe(1024);
  });
});
