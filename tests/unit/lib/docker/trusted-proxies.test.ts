import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/docker/client", () => ({ dockerRequest: vi.fn() }));

import {
  desiredTrustedIps,
  runningTrustedIps,
  syncTraefikTrustedIps,
  TRUSTED_IPS_KEY,
  type TraefikContainer,
} from "@/lib/docker/trusted-proxies";

const RANGES = ["173.245.48.0/20", "2400:cb00::/32"];
const flags = (value: string) => [
  "--entrypoints.web.address=:80",
  `--entrypoints.web.forwardedheaders.trustedips=${value}`,
  `--entrypoints.websecure.forwardedheaders.trustedips=${value}`,
];

function setup(traefik: TraefikContainer | null, compose = `trustedips=\${${TRUSTED_IPS_KEY}-x}`) {
  const writeEnv = vi.fn(async () => {});
  const recreate = vi.fn(async () => {});
  const deps = {
    inspect: async () => traefik,
    composeFile: () => "/opt/vardo/apps/vardo/env/current/docker-compose.yml",
    readCompose: async () => compose,
    envFiles: async () => ["/opt/vardo/.env", "/opt/vardo/apps/vardo/env/current/.env"],
    writeEnv,
    recreate,
  };
  return { deps, writeEnv, recreate, attempts: new Set<string>() };
}

const compose = (args: string[]): TraefikContainer => ({ args, project: "vardo", service: "traefik" });

describe("desiredTrustedIps", () => {
  it("joins the ranges, or trusts nothing when opted out", () => {
    expect(desiredTrustedIps(RANGES, {})).toBe("173.245.48.0/20,2400:cb00::/32");
    expect(desiredTrustedIps(RANGES, { VARDO_TRUST_CLOUDFLARE: "false" })).toBe("");
  });
});

describe("runningTrustedIps", () => {
  it("reads each entrypoint's flag, missing as empty", () => {
    expect(runningTrustedIps(flags("1.1.1.0/24"))).toEqual({ web: "1.1.1.0/24", websecure: "1.1.1.0/24" });
    expect(runningTrustedIps(["--entrypoints.web.address=:80"])).toEqual({ web: "", websecure: "" });
  });
});

describe("syncTraefikTrustedIps", () => {
  it("leaves Traefik alone when it already trusts the list, in any order", async () => {
    const t = setup(compose(flags("2400:cb00::/32,173.245.48.0/20")));
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: t.deps, attempts: t.attempts })).toBe("unchanged");
    expect(t.recreate).not.toHaveBeenCalled();
    expect(t.writeEnv).not.toHaveBeenCalled();
  });

  it("writes the list and recreates Traefik when the ranges changed", async () => {
    const t = setup(compose(flags("173.245.48.0/20")));
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: t.deps, attempts: t.attempts })).toBe("recreated");
    const value = RANGES.join(",");
    expect(t.writeEnv).toHaveBeenCalledWith("/opt/vardo/.env", TRUSTED_IPS_KEY, value);
    expect(t.writeEnv).toHaveBeenCalledWith("/opt/vardo/apps/vardo/env/current/.env", TRUSTED_IPS_KEY, value);
    expect(t.recreate).toHaveBeenCalledWith("/opt/vardo/apps/vardo/env/current/docker-compose.yml", "vardo", "traefik", value);
  });

  it("recreates a Traefik started before the flags existed", async () => {
    const t = setup(compose(["--entrypoints.web.address=:80"]));
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: t.deps, attempts: t.attempts })).toBe("recreated");
  });

  it("clears the list when opted out, and only once", async () => {
    const t = setup(compose(flags(RANGES.join(","))));
    const env = { VARDO_TRUST_CLOUDFLARE: "false" };
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env, deps: t.deps, attempts: t.attempts })).toBe("recreated");
    expect(t.writeEnv).toHaveBeenCalledWith("/opt/vardo/.env", TRUSTED_IPS_KEY, "");
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env, deps: t.deps, attempts: t.attempts })).toBe("skipped");
    expect(t.recreate).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an opted-out host whose Traefik never had the flags", async () => {
    const t = setup(compose(["--entrypoints.web.address=:80"]));
    const env = { VARDO_TRUST_CLOUDFLARE: "false" };
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env, deps: t.deps, attempts: t.attempts })).toBe("unchanged");
  });

  it("skips without Traefik, without compose labels or when the compose file doesn't read the key", async () => {
    const none = setup(null);
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: none.deps, attempts: none.attempts })).toBe("skipped");
    const manual = setup({ args: [] });
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: manual.deps, attempts: manual.attempts })).toBe("skipped");
    const old = setup(compose([]), "services: {}");
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: old.deps, attempts: old.attempts })).toBe("skipped");
    expect(old.recreate).not.toHaveBeenCalled();
  });

  it("reports a failed recreate", async () => {
    const t = setup(compose([]));
    t.deps.recreate = vi.fn(async () => {
      throw new Error("compose failed");
    });
    expect(await syncTraefikTrustedIps({ ranges: RANGES, env: {}, deps: t.deps, attempts: t.attempts })).toBe("failed");
  });
});
