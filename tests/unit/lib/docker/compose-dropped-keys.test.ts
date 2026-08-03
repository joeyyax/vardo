import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildVardoOverlay, defaultMemoryLimitMb } from "@/lib/docker/compose-inject";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";
import { droppedKeyWarnings, parseComposeYaml } from "@/lib/docker/compose-validate";
import { partitionBySlot } from "@/lib/docker/slot-partition";
import type { ServiceConfigOverride } from "@/lib/docker/compose-types";

const NETWORK = "vardo-network";

const ADDITIVE_SOURCE = `services:
  app:
    image: nginx
    read_only: true
    stdin_open: true
    tty: true
    working_dir: /srv
    pull_policy: never
    stop_grace_period: 45s
    dns: 1.1.1.1
    dns_search:
      - example.test
    dns_opt:
      - ndots:2
    sysctls:
      net.ipv4.ip_forward: 1
`;

describe("additive service keys the parser now carries", () => {
  it("survives parsing", () => {
    const svc = parseCompose(ADDITIVE_SOURCE).services.app;
    expect(svc.read_only).toBe(true);
    expect(svc.stdin_open).toBe(true);
    expect(svc.tty).toBe(true);
    expect(svc.working_dir).toBe("/srv");
    expect(svc.pull_policy).toBe("never");
    expect(svc.stop_grace_period).toBe("45s");
    expect(svc.dns).toEqual(["1.1.1.1"]);
    expect(svc.dns_search).toEqual(["example.test"]);
    expect(svc.dns_opt).toEqual(["ndots:2"]);
    expect(svc.sysctls).toEqual({ "net.ipv4.ip_forward": 1 });
  });

  it("accepts the list form of sysctls", () => {
    const compose = parseCompose(`services:
  vpn:
    image: wireguard
    sysctls:
      - net.ipv4.ip_forward=1
`);
    expect(compose.services.vpn.sysctls).toEqual(["net.ipv4.ip_forward=1"]);
  });

  it("survives a YAML round trip, so it still reaches the container", () => {
    const once = parseCompose(ADDITIVE_SOURCE);
    const twice = parseCompose(composeToYaml(once));
    expect(twice.services.app).toEqual(once.services.app);
  });

  it("survives slot partitioning", () => {
    const { slotted } = partitionBySlot(parseCompose(ADDITIVE_SOURCE));
    expect(slotted.app.read_only).toBe(true);
    expect(slotted.app.sysctls).toEqual({ "net.ipv4.ip_forward": 1 });
  });

  it("no longer warns about keys that are now applied", () => {
    expect(droppedKeyWarnings(parseComposeYaml(ADDITIVE_SOURCE))).toEqual([]);
  });

  it("still warns about keys that remain dropped", () => {
    const warnings = droppedKeyWarnings(
      parseComposeYaml(`services:
  app:
    image: nginx
    logging:
      driver: none
    profiles: [debug]
    cpus: 4
    platform: linux/arm64
    extends:
      service: base
`),
    );
    expect(warnings).toHaveLength(1);
    for (const key of ["logging", "profiles", "cpus", "platform", "extends"]) {
      expect(warnings[0]).toContain(`"${key}"`);
    }
  });
});

describe("mem_limit folds into deploy.resources.limits.memory", () => {
  it("normalizes to the single field the overlay reads", () => {
    const svc = parseCompose(`services:
  app:
    image: nginx
    mem_limit: 128m
`).services.app;
    expect(svc.deploy?.resources?.limits?.memory).toBe("128m");
  });

  it("leaves an explicit deploy limit alone", () => {
    const svc = parseCompose(`services:
  app:
    image: nginx
    mem_limit: 128m
    deploy:
      resources:
        limits:
          memory: 2g
`).services.app;
    expect(svc.deploy?.resources?.limits?.memory).toBe("2g");
  });

  it("keeps a sibling cpus limit intact", () => {
    const svc = parseCompose(`services:
  app:
    image: nginx
    mem_limit: 512m
    deploy:
      resources:
        limits:
          cpus: "4"
`).services.app;
    expect(svc.deploy?.resources?.limits).toEqual({ cpus: "4", memory: "512m" });
  });

  it("reads a bare integer as bytes, the way Docker does", () => {
    const svc = parseCompose(`services:
  app:
    image: nginx
    mem_limit: 268435456
`).services.app;
    expect(svc.deploy?.resources?.limits?.memory).toBe("268435456");
  });

  it("ignores an empty value rather than emitting an invalid limit", () => {
    const svc = parseCompose(`services:
  app:
    image: nginx
    mem_limit: ""
`).services.app;
    expect(svc.deploy?.resources?.limits?.memory).toBeUndefined();
  });
});

describe("buildVardoOverlay — memory precedence", () => {
  type OverlayOpts = {
    memoryLimit?: number | null;
    serviceConfig?: Record<string, ServiceConfigOverride>;
  };

  /** The memory limit the overlay lands on for service "app". */
  function overlayMemory(yaml: string, opts: OverlayOpts = {}): string | undefined {
    const overlay = buildVardoOverlay({
      fullCompose: parseCompose(yaml),
      networkName: NETWORK,
      ...opts,
    });
    return overlay.services.app.deploy?.resources?.limits?.memory;
  }

  const WITH_MEM_LIMIT = `services:
  app:
    image: nginx
    mem_limit: 128m
`;

  it("uses the tier default when the compose declares nothing", () => {
    expect(overlayMemory("services:\n  app:\n    image: nginx\n")).toBe(
      `${defaultMemoryLimitMb("standard")}M`,
    );
  });

  it("honors a compose mem_limit over the tier default", () => {
    expect(overlayMemory(WITH_MEM_LIMIT)).toBe("128m");
  });

  it("honors a compose deploy limit over the tier default", () => {
    const yaml = `services:
  app:
    image: nginx
    deploy:
      resources:
        limits:
          memory: 10g
`;
    expect(overlayMemory(yaml)).toBe("10g");
  });

  it("lets the app's own limit beat the compose file", () => {
    expect(overlayMemory(WITH_MEM_LIMIT, { memoryLimit: 512 })).toBe("512M");
  });

  it("lets a decomposed child's limit beat the compose file", () => {
    const memory = overlayMemory(WITH_MEM_LIMIT, {
      memoryLimit: 512,
      serviceConfig: {
        app: { cpuLimit: null, memoryLimit: 2048, gpuEnabled: false, priority: null },
      },
    });
    expect(memory).toBe("2048M");
  });

  it("treats an explicit 0 as no cap, even against a compose mem_limit", () => {
    expect(overlayMemory(WITH_MEM_LIMIT, { memoryLimit: 0 })).toBeUndefined();
  });

  it("does not turn a compose mem_limit into a critical-tier reservation", () => {
    const overlay = buildVardoOverlay({
      fullCompose: parseCompose(WITH_MEM_LIMIT),
      networkName: NETWORK,
      priority: "critical",
    });
    expect(overlay.services.app.deploy?.resources?.reservations).toBeUndefined();
    expect(overlay.services.app.deploy?.resources?.limits?.memory).toBe("128m");
  });

  it("writes the same value into the base file and the override", () => {
    const compose = parseCompose(WITH_MEM_LIMIT);
    const overlay = buildVardoOverlay({ fullCompose: compose, networkName: NETWORK });
    // Docker resolves a repeated scalar by last file wins, so the two agreeing
    // is what makes the merged limit predictable.
    expect(compose.services.app.deploy?.resources?.limits?.memory).toBe("128m");
    expect(overlay.services.app.deploy?.resources?.limits?.memory).toBe("128m");
    expect(YAML.stringify(compose)).not.toContain("mem_limit");
  });
});

describe("the promtail template's stated limit", () => {
  it("is the limit the deployed container gets", () => {
    const path = resolve(process.cwd(), "templates/promtail.yaml");
    const template = YAML.parse(readFileSync(path, "utf-8")) as { composeContent: string };
    const compose = parseCompose(template.composeContent);
    const declared = compose.services.promtail.deploy?.resources?.limits?.memory;
    expect(declared).toBe("256m");

    const overlay = buildVardoOverlay({ fullCompose: compose, networkName: NETWORK });
    expect(overlay.services.promtail.deploy?.resources?.limits?.memory).toBe(declared);
  });
});
