// Deploy gate for Traefik label hosts (#887).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { tables } = vi.hoisted(() => ({ tables: new Map<unknown, unknown[]>() }));

vi.mock("@/lib/db", async () => {
  const schema = await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  // Each select resolves to the rows queued for its table; filters are the loader's job.
  const select = () => {
    let table: unknown;
    const chain = {
      from: (t: unknown) => { table = t; return chain; },
      innerJoin: () => chain,
      where: () => Promise.resolve(tables.get(table) ?? []),
    };
    return chain;
  };
  void schema;
  return { db: { select } };
});
vi.mock("@/lib/system-settings", () => ({
  getInstanceConfig: vi.fn().mockResolvedValue({ baseDomain: "vardo.test", domain: "console.vardo.test", instanceName: "", serverIp: "" }),
}));

import { apps, domains, environments, organizations, orgDomains } from "@/lib/db/schema";
import { assertLabelHostsOwned } from "@/lib/docker/label-hosts";
import { DeployBlockedError } from "@/lib/docker/errors";
import { collectLabelRules } from "@/lib/docker/compose-hosts";
import type { ComposeFile } from "@/lib/docker/compose-types";

const ORG = "org-a";

function ctx(over: { trusted?: boolean; baseDomain?: string | null; envMap?: Record<string, string>; domains?: string[] } = {}) {
  const log = vi.fn();
  return {
    organizationId: ORG,
    orgTrusted: over.trusted ?? false,
    org: { id: ORG, name: "A", baseDomain: over.baseDomain ?? null, trusted: over.trusted ?? false },
    envMap: over.envMap ?? {},
    log,
    app: { domains: (over.domains ?? []).map((domain) => ({ domain })) } as never,
  };
}

function compose(rule: string, key = "traefik.http.routers.web.rule"): ComposeFile {
  return { services: { web: { name: "web", image: "nginx", labels: { "traefik.enable": "true", [key]: rule } } } };
}

beforeEach(() => {
  tables.clear();
  tables.set(organizations, [{ isSystemManaged: false }]);
  tables.set(domains, [
    { domain: "shop.org-a.com", orgId: ORG },
    { domain: "victim.com", orgId: "org-b" },
  ]);
  tables.set(environments, [{ domain: "staging.org-b.com", orgId: "org-b" }]);
  tables.set(orgDomains, []);
  tables.set(apps, []);
});

describe("assertLabelHostsOwned", () => {
  it("refuses a label claiming another org's domain, trusted or not", async () => {
    for (const trusted of [false, true]) {
      await expect(assertLabelHostsOwned(ctx({ trusted }), compose("Host(`victim.com`)")))
        .rejects.toThrow(/claims "victim.com", which is already in use on this instance/);
    }
  });

  it("refuses another org's environment domain and the console host", async () => {
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`staging.org-b.com`)"))).rejects.toThrow(DeployBlockedError);
    await expect(assertLabelHostsOwned(ctx({ trusted: true, baseDomain: "vardo.test" }), compose("Host(`console.vardo.test`)")))
      .rejects.toThrow(/already in use/);
  });

  it("refuses a second host hidden behind ||", async () => {
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`shop.org-a.com`) || Host(`victim.com`)"))).rejects.toThrow(/victim.com/);
  });

  it("refuses an HTTP rule that skips the host and a TCP catch-all", async () => {
    await expect(assertLabelHostsOwned(ctx({ trusted: true }), compose("PathPrefix(`/`)"))).rejects.toThrow(/matches every hostname/);
    await expect(assertLabelHostsOwned(ctx({ trusted: true }), compose("HostSNI(`*`)", "traefik.tcp.routers.db.rule")))
      .rejects.toThrow(/every hostname/);
  });

  it("finds rule labels whatever their case", async () => {
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`victim.com`)", "Traefik.HTTP.Routers.web.Rule"))).rejects.toThrow(/victim.com/);
  });

  it("allows the org's own domain rows, including another app's", async () => {
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`shop.org-a.com`) && PathPrefix(`/api`)"))).resolves.toHaveLength(1);
  });

  it("refuses an unregistered host for an untrusted org and allows it under a trusted org's base domain", async () => {
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`new.org-a.com`)"))).rejects.toThrow(/doesn't own/);
    await expect(assertLabelHostsOwned(ctx({ baseDomain: "org-a.com" }), compose("Host(`new.org-a.com`)"))).rejects.toThrow(/doesn't own/);
    await expect(assertLabelHostsOwned(ctx({ trusted: true, baseDomain: "org-a.com" }), compose("Host(`new.org-a.com`)"))).resolves.toHaveLength(1);
  });

  it("gives an app the instance subdomains its name prefixes, unless a longer name belongs elsewhere", async () => {
    tables.set(apps, [{ name: "blog", orgId: ORG }, { name: "blog-admin", orgId: "org-b" }]);
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`blog.vardo.test`)"))).resolves.toHaveLength(1);
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`blog-staging.vardo.test`)"))).resolves.toHaveLength(1);
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`blog-admin.vardo.test`)"))).rejects.toThrow(/already in use/);
  });

  it("checks HostRegexp zones", async () => {
    tables.set(domains, [{ domain: "victim.com", orgId: "org-b" }]);
    tables.set(orgDomains, [{ domain: "org-a.com", verified: true }]);
    await expect(assertLabelHostsOwned(ctx(), compose("HostRegexp(`^[a-z]+\\.org-a\\.com$$`)"))).resolves.toHaveLength(1);
    await expect(assertLabelHostsOwned(ctx(), compose("HostRegexp(`^.+\\.vardo\\.test$$`)"))).rejects.toThrow(/subdomain/);
    // A zone holding another org's row would shadow it.
    tables.set(domains, [{ domain: "x.org-a.com", orgId: "org-b" }]);
    await expect(assertLabelHostsOwned(ctx(), compose("HostRegexp(`^[a-z]+\\.org-a\\.com$$`)"))).rejects.toThrow(/already in use/);
  });

  it("counts unverified org domains for trusted orgs only", async () => {
    tables.set(orgDomains, [{ domain: "org-a.com", verified: false }]);
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`new.org-a.com`)"))).rejects.toThrow(DeployBlockedError);
    await expect(assertLabelHostsOwned(ctx({ trusted: true }), compose("Host(`new.org-a.com`)"))).resolves.toHaveLength(1);
  });

  it("refuses rules it can't read for untrusted orgs only", async () => {
    await expect(assertLabelHostsOwned(ctx(), compose("HostRegexp(`.+`)"))).rejects.toThrow(/couldn't be checked/);
    const trusted = ctx({ trusted: true });
    await expect(assertLabelHostsOwned(trusted, compose("HostRegexp(`.+`)"))).resolves.toHaveLength(1);
    expect(trusted.log).toHaveBeenCalledWith(expect.stringMatching(/not checked/));
    await expect(assertLabelHostsOwned(ctx(), compose("Host(`a.com`"))).rejects.toThrow(/couldn't be checked/);
  });

  it("resolves variables like Compose and never echoes them", async () => {
    await expect(assertLabelHostsOwned(ctx({ envMap: { HOST: "shop.org-a.com" } }), compose("Host(`${HOST}`)"))).resolves.toHaveLength(1);
    process.env.LABEL_HOSTS_TEST_SECRET = "s3cret";
    try {
      const err = await assertLabelHostsOwned(ctx(), compose("Host(`${LABEL_HOSTS_TEST_SECRET}`)")).catch((e: Error) => e);
      expect(err).toBeInstanceOf(DeployBlockedError);
      expect((err as Error).message).not.toContain("s3cret");
    } finally {
      delete process.env.LABEL_HOSTS_TEST_SECRET;
    }
  });

  it("skips the system-managed org", async () => {
    tables.set(organizations, [{ isSystemManaged: true }]);
    await expect(assertLabelHostsOwned(ctx(), compose("PathPrefix(`/`)"))).resolves.toEqual([]);
  });

  it("skips the lookup when every rule routes this deploy's own domains", async () => {
    tables.clear();
    await expect(assertLabelHostsOwned(ctx({ domains: ["mine.org-a.com"] }), compose("Host(`mine.org-a.com`)"))).resolves.toEqual([]);
  });
});

describe("collectLabelRules", () => {
  it("ignores labels that aren't router rules", () => {
    const rules = collectLabelRules({
      services: { web: { name: "web", labels: { "traefik.http.routers.web.entrypoints": "websecure", "traefik.http.services.web.loadbalancer.server.port": "80" } } },
    });
    expect(rules).toEqual([]);
  });
});
