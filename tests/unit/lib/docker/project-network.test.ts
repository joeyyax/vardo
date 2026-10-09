import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, rm, writeFile, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  attachableServices,
  injectProjectNetwork,
  isProjectNetwork,
  projectNetworkCollisions,
  projectNetworkName,
} from "@/lib/docker/project-network";
import { buildVardoOverlay, injectNetwork, stripVardoInjections, composeToYaml } from "@/lib/docker/compose";
import { composePolicyErrors, type ComposePolicy } from "@/lib/docker/compose-policy";
import { partitionBySlot } from "@/lib/docker/slot-partition";
import { sharedNetworks } from "@/lib/docker/shared-networks";
import { dockerEnv } from "@/lib/docker/docker-env";
import type { ComposeFile } from "@/lib/docker/compose-types";

const NET = "vardo-p-proj123-production";

function appWithDb(): ComposeFile {
  return {
    services: {
      web: { name: "web", image: "web", labels: { "traefik.enable": "true" } },
      postgres: { name: "postgres", image: "postgres:17", volumes: ["pg:/var/lib/postgresql/data"] },
      sidecar: { name: "sidecar", image: "busybox", network_mode: "service:web" },
    },
    volumes: { pg: null },
  };
}

describe("projectNetworkName", () => {
  it("scopes by project id and environment", () => {
    expect(projectNetworkName("proj123", "production")).toBe(NET);
    expect(projectNetworkName("proj123", "pr-7")).toBe("vardo-p-proj123-pr-7");
    expect(projectNetworkName("abc", "staging")).not.toBe(projectNetworkName("abd", "staging"));
  });

  it("replaces characters Docker refuses in a network name", () => {
    expect(projectNetworkName("a/b", "my env")).toBe("vardo-p-a-b-my-env");
  });

  it("is recognized as a project network", () => {
    expect(isProjectNetwork(NET)).toBe(true);
    expect(isProjectNetwork("vardo-network")).toBe(false);
  });
});

describe("injectProjectNetwork", () => {
  it("attaches every service that can join a network and declares it external", () => {
    const out = injectProjectNetwork(appWithDb(), NET);
    expect(out.services.web.networks).toEqual(["default", NET]);
    expect(out.services.postgres.networks).toEqual(["default", NET]);
    expect(out.networks?.[NET]).toEqual({ external: true });
  });

  it("leaves network_mode services alone", () => {
    const out = injectProjectNetwork(appWithDb(), NET);
    expect(out.services.sidecar.networks).toBeUndefined();
    expect(attachableServices(appWithDb())).toEqual(["web", "postgres"]);
  });

  it("keeps declared networks instead of adding default", () => {
    const compose: ComposeFile = {
      services: { api: { name: "api", image: "api", networks: ["internal"] } },
      networks: { internal: null },
    };
    const out = injectProjectNetwork(compose, NET);
    expect(out.services.api.networks).toEqual(["internal", NET]);
    expect(out.networks).toEqual({ internal: null, [NET]: { external: true } });
  });

  it("is idempotent", () => {
    const once = injectProjectNetwork(appWithDb(), NET);
    expect(injectProjectNetwork(once, NET)).toEqual(once);
  });

  it("covers a generated single-service compose (image, dockerfile, railpack, nixpacks)", () => {
    const compose: ComposeFile = { services: { "shop-east": { name: "shop-east", image: "shop:abc" } } };
    expect(injectProjectNetwork(compose, NET).services["shop-east"].networks).toEqual(["default", NET]);
  });

  it("keeps a routed service on its default network once vardo-network is added", () => {
    const out = injectNetwork(injectProjectNetwork(appWithDb(), NET), "vardo-network", { attachTo: new Set(["web"]) });
    expect(out.services.web.networks).toEqual(["default", NET, "vardo-network"]);
    expect(out.services.postgres.networks).toEqual(["default", NET]);
  });
});

describe("projectNetworkCollisions", () => {
  const peers = [
    { service: "postgres", appId: "a1", appName: "shop-db" },
    { service: "postgres", appId: "a1", appName: "shop-db" },
    { service: "web", appId: "me", appName: "me" },
    { service: "shop-east", appId: "a2", appName: "shop-east" },
  ];

  it("reports another app's service with the same name once", () => {
    expect(projectNetworkCollisions("me", ["web", "postgres"], peers)).toEqual([
      { service: "postgres", appId: "a1", appName: "shop-db" },
    ]);
  });

  it("ignores the app's own containers, including the other slot", () => {
    expect(projectNetworkCollisions("me", ["web"], peers)).toEqual([]);
  });

  it("is empty when names differ", () => {
    expect(projectNetworkCollisions("me", ["shop-west"], peers)).toEqual([]);
  });
});

describe("buildVardoOverlay with a project network", () => {
  it("carries the project network and the default network into the overlay", () => {
    const full = injectNetwork(injectProjectNetwork(appWithDb(), NET), "vardo-network", { attachTo: new Set(["web"]) });
    const overlay = buildVardoOverlay({ fullCompose: full, networkName: "vardo-network", projectNetwork: NET, hostCpus: 2 });
    expect(overlay.services.web.networks).toEqual(["default", NET, "vardo-network"]);
    expect(overlay.services.postgres.networks).toEqual(["default", NET]);
    expect(overlay.services.sidecar.networks).toBeUndefined();
    expect(overlay.networks).toEqual({ "vardo-network": { external: true }, [NET]: { external: true } });
  });

  it("leaves the bare file without Vardo's networks", () => {
    const full = injectProjectNetwork(appWithDb(), NET);
    const bare = stripVardoInjections(full);
    expect(bare.networks).toBeUndefined();
    expect(bare.services.web.networks).toEqual(["default"]);
  });

  it("carries only vardo-network and default without a project network", () => {
    const full = injectNetwork(appWithDb(), "vardo-network", { attachTo: new Set(["web"]) });
    const overlay = buildVardoOverlay({ fullCompose: full, networkName: "vardo-network", hostCpus: 2 });
    expect(overlay.services.web.networks).toEqual(["default", "vardo-network"]);
    expect(overlay.services.postgres.networks).toBeUndefined();
    expect(overlay.networks).toEqual({ "vardo-network": { external: true } });
  });
});

describe("slotted and shared services", () => {
  function withShared(): ComposeFile {
    const compose = appWithDb();
    delete compose.services.sidecar;
    compose.services.postgres["x-vardo-shared"] = true;
    return injectProjectNetwork(compose, NET);
  }

  it("attaches both halves of the partition", () => {
    const { shared, slotted } = partitionBySlot(withShared());
    expect(shared.postgres.networks).toContain(NET);
    expect(slotted.web.networks).toContain(NET);
  });

  it("never externalizes the project network as a shared one", () => {
    expect([...sharedNetworks(withShared())]).toEqual(["default"]);
  });

  it("gives the shared service the same overlay networks from either slot", () => {
    const overlay = buildVardoOverlay({ fullCompose: withShared(), networkName: "vardo-network", projectNetwork: NET, hostCpus: 2 });
    expect(overlay.services.postgres.networks).toEqual(["default", NET]);
  });
});

const untrusted: ComposePolicy = {
  trusted: false,
  projectName: "shop-db-production-blue",
  ownDirs: ["/opt/vardo/apps/shop-db/production"],
  ownPrefix: "shop-db-production_",
  allowBindMounts: false,
  allowDockerSocket: false,
  projectNetwork: NET,
  realpath: (p) => p,
};

function resolved(attach: unknown = null, netName = NET): Record<string, unknown> {
  return {
    name: "shop-db-production-blue",
    services: { postgres: { image: "postgres:17", networks: { default: null, pn: attach } } },
    networks: {
      default: { name: "shop-db-production-blue_default" },
      pn: { name: netName, external: true },
    },
  };
}

describe("compose policy and the project network", () => {
  it("lets an untrusted app's unrouted service join its own project network", () => {
    expect(composePolicyErrors(resolved(), untrusted)).toEqual([]);
  });

  it("refuses another project's network", () => {
    expect(composePolicyErrors(resolved(null, "vardo-p-other-production"), untrusted)).toEqual([
      'Network "pn" joins "vardo-p-other-production", which isn\'t this app\'s',
    ]);
  });

  it("refuses aliases on the project network", () => {
    expect(composePolicyErrors(resolved({ aliases: ["shop-west"] }), untrusted)).toEqual([
      'Service "postgres" sets addresses or aliases on the project network',
    ]);
  });

  it("still refuses an unrouted service joining vardo-network", () => {
    const cfg = resolved();
    (cfg.networks as Record<string, unknown>)["vardo-network"] = { name: "vardo-network", external: true };
    (cfg.services as Record<string, { networks: Record<string, unknown> }>).postgres.networks["vardo-network"] = null;
    expect(composePolicyErrors(cfg, untrusted)).toEqual([
      'Service "postgres" joins vardo-network without being routed by Vardo',
    ]);
  });
});

function hasCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { env: dockerEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasCompose())("bare plus overlay, resolved by docker compose", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vardo-project-net-")));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps every service on its default network and the project network", async () => {
    const user = appWithDb();
    const full = injectNetwork(injectProjectNetwork(user, NET), "vardo-network", { attachTo: new Set(["web"]) });
    await writeFile(join(dir, "docker-compose.yml"), composeToYaml(stripVardoInjections(full)));
    await writeFile(
      join(dir, "docker-compose.override.yml"),
      composeToYaml(buildVardoOverlay({ fullCompose: full, networkName: "vardo-network", projectNetwork: NET, hostCpus: 2 })),
    );
    const out = execFileSync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.override.yml", "-p", "app-production-blue", "config", "--format", "json"],
      { cwd: dir, env: dockerEnv(), encoding: "utf-8" },
    );
    const cfg = JSON.parse(out) as { services: Record<string, { networks?: Record<string, unknown> }>; networks: Record<string, { name: string; external?: boolean }> };
    expect(Object.keys(cfg.services.web.networks ?? {}).sort()).toEqual(["default", NET, "vardo-network"].sort());
    expect(Object.keys(cfg.services.postgres.networks ?? {}).sort()).toEqual(["default", NET].sort());
    expect(cfg.networks[NET]).toMatchObject({ name: NET, external: true });
    expect(composePolicyErrors(cfg, {
      ...untrusted,
      projectName: "app-production-blue",
      ownDirs: [dir],
      ownPrefix: "app-production_",
    })).toEqual([]);
  });
});
