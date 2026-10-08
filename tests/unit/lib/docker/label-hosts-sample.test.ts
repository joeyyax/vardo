// Every Traefik rule running on the homelab today must still deploy (#887).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { collectLabelRules, judgeLabelRules, type LabelVerdict } from "@/lib/docker/compose-hosts";
import { buildHostOwnership } from "@/lib/docker/label-hosts";
import type { ComposeFile } from "@/lib/docker/compose-types";

type Fixture = {
  instanceBase: string;
  consoleHosts: string[];
  shellEnv: Record<string, string>;
  orgs: Record<string, { trusted: boolean; baseDomain: string | null; systemManaged: boolean }>;
  domains: { app: string; domain: string; org: string }[];
  envDomains: { app: string; domain: string; org: string }[];
  topLevelApps: { name: string; org: string }[];
  apps: { app: string; org: string; labels: { source: string; service: string; label: string; rule: string }[] }[];
};

const fx: Fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/sample-label-hosts.json"), "utf-8"),
);

function verdicts(entry: Fixture["apps"][number], orgOverride?: Partial<Fixture["orgs"][string]>): LabelVerdict[] {
  const org = { ...fx.orgs[entry.org], ...orgOverride };
  const ownership = buildHostOwnership(
    {
      organizationId: entry.org,
      trusted: org.trusted,
      orgBaseDomain: org.baseDomain,
      deployHosts: fx.domains.filter((d) => d.app === entry.app).map((d) => d.domain),
    },
    {
      instanceBase: fx.instanceBase,
      consoleHosts: fx.consoleHosts,
      hostRows: [...fx.domains, ...fx.envDomains].map((d) => ({ domain: d.domain, orgId: d.org, counts: true })),
      orgDomainRows: [],
      appNames: fx.topLevelApps.map((a) => ({ name: a.name, orgId: a.org })),
    },
  );
  // One service per label keeps same-named router keys from different sources apart.
  const compose: ComposeFile = {
    services: Object.fromEntries(
      entry.labels.map((l, i) => [`${l.source}:${l.service}:${i}`, { name: l.service, labels: { [l.label]: l.rule } }]),
    ),
  };
  return judgeLabelRules(collectLabelRules(compose, {}, fx.shellEnv), ownership);
}

const tenantApps = fx.apps.filter((a) => !fx.orgs[a.org].systemManaged);
const systemApps = fx.apps.filter((a) => fx.orgs[a.org].systemManaged);

describe("homelab Traefik labels (#887)", () => {
  it("covers the snapshot", () => {
    expect(tenantApps.length).toBeGreaterThan(40);
    expect(fx.apps.flatMap((a) => a.labels).length).toBeGreaterThan(250);
  });

  it.each(tenantApps.map((a) => [a.app, a] as const))("%s deploys with every label owned", (_name, entry) => {
    const refused = verdicts(entry).filter((v) => !v.allowed);
    expect(refused).toEqual([]);
  });

  it("checks every tenant rule with confidence, without leaning on trust", () => {
    const uncertain = tenantApps.flatMap((a) => verdicts(a)).filter((v) => v.verdict !== "owned");
    expect(uncertain).toEqual([]);
  });

  it("would refuse the console's own catch-all routing, so the system org is skipped", () => {
    const refused = systemApps.flatMap((a) => verdicts(a)).filter((v) => !v.allowed);
    expect(refused.map((v) => v.raw)).toContain("PathPrefix(`/`)");
    expect(refused.map((v) => v.raw)).toContain("Host(`${VARDO_DOMAIN:-localhost}`)");
  });

  it("depends on trust for the hosts outside domain rows", () => {
    const llama = fx.apps.find((a) => a.app === "llm-proxy")!;
    expect(verdicts(llama, { trusted: false }).some((v) => !v.allowed)).toBe(true);
  });
});
