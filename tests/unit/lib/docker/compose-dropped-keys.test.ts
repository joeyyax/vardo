import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  buildVardoOverlay,
  defaultCpuLimit,
  defaultMemoryLimitMb,
  defaultPidsLimit,
} from "@/lib/docker/compose-inject";
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
    cpuset: "0-3"
    platform: linux/arm64
    extends:
      service: base
`),
    );
    expect(warnings).toHaveLength(1);
    for (const key of ["logging", "cpuset", "platform", "extends"]) {
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

describe("memswap_limit is carried like mem_limit", () => {
  const SRC = "services:\n  app:\n    image: nginx\n    mem_limit: 128m\n    memswap_limit: 256m\n";

  it("survives parsing, a YAML round trip and slot partitioning", () => {
    const once = parseCompose(SRC);
    expect(once.services.app.memswap_limit).toBe("256m");
    expect(parseCompose(composeToYaml(once)).services.app.memswap_limit).toBe("256m");
    expect(partitionBySlot(once).slotted.app.memswap_limit).toBe("256m");
  });

  it("keeps a numeric value, including -1 for unlimited swap", () => {
    const svc = parseCompose("services:\n  app:\n    image: nginx\n    memswap_limit: -1\n").services.app;
    expect(svc.memswap_limit).toBe(-1);
  });

  it("ignores an empty value", () => {
    const svc = parseCompose('services:\n  app:\n    image: nginx\n    memswap_limit: ""\n').services.app;
    expect(svc.memswap_limit).toBeUndefined();
  });

  it("no longer warns that it's dropped", () => {
    expect(droppedKeyWarnings(parseComposeYaml(SRC))).toEqual([]);
  });
});

describe("cpus folds into deploy.resources.limits.cpus", () => {
  /** The CPU limit service "app" carries after parsing. */
  function parsedCpus(yaml: string): string | undefined {
    return parseCompose(yaml).services.app.deploy?.resources?.limits?.cpus;
  }

  it("normalizes a bare number to the field the pipeline reads", () => {
    expect(parsedCpus("services:\n  app:\n    image: nginx\n    cpus: 1.5\n")).toBe("1.5");
  });

  it("normalizes the quoted form the same way", () => {
    expect(parsedCpus('services:\n  app:\n    image: nginx\n    cpus: "2"\n')).toBe("2");
  });

  it("leaves an explicit deploy limit alone", () => {
    const yaml = `services:
  app:
    image: nginx
    cpus: 1.5
    deploy:
      resources:
        limits:
          cpus: "4"
`;
    expect(parsedCpus(yaml)).toBe("4");
  });

  it("keeps a sibling memory limit intact", () => {
    const svc = parseCompose(`services:
  app:
    image: nginx
    cpus: 2
    deploy:
      resources:
        limits:
          memory: 512m
`).services.app;
    expect(svc.deploy?.resources?.limits).toEqual({ cpus: "2", memory: "512m" });
  });

  it("keeps zero, which opts out of the tier default", () => {
    expect(parsedCpus("services:\n  app:\n    image: nginx\n    cpus: 0\n")).toBe("0");
  });

  it("ignores empty and unparseable values", () => {
    expect(parsedCpus('services:\n  app:\n    image: nginx\n    cpus: ""\n')).toBeUndefined();
    expect(parsedCpus("services:\n  app:\n    image: nginx\n    cpus: many\n")).toBeUndefined();
  });

  it("no longer warns about a key it now applies", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    cpus: 1.5\n";
    expect(droppedKeyWarnings(parseComposeYaml(yaml))).toEqual([]);
  });

  it("writes the same value into the base file and the override", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    cpus: 1.5\n";
    const compose = parseCompose(yaml);
    const overlay = buildVardoOverlay({ fullCompose: compose, networkName: NETWORK, cpuLimit: 2 });
    expect(compose.services.app.deploy?.resources?.limits?.cpus).toBe("1.5");
    expect(overlay.services.app.deploy?.resources?.limits?.cpus).toBe("2");
    const raw = YAML.parse(composeToYaml(compose)) as { services: Record<string, Record<string, unknown>> };
    expect(raw.services.app.cpus).toBeUndefined();
  });

  it("survives a YAML round trip, so it still reaches the container", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    cpus: 1.5\n";
    expect(parsedCpus(composeToYaml(parseCompose(yaml)))).toBe("1.5");
  });
});

describe("pids_limit folds into deploy.resources.limits.pids (#889)", () => {
  /** The pids limit service "app" carries after parsing. */
  function parsedPids(yaml: string): number | string | undefined {
    return parseCompose(yaml).services.app.deploy?.resources?.limits?.pids;
  }

  it("carries pids_limit instead of dropping it", () => {
    expect(parsedPids("services:\n  app:\n    image: nginx\n    pids_limit: 200\n")).toBe(200);
  });

  it("no longer warns about pids_limit", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    pids_limit: 200\n";
    expect(droppedKeyWarnings(parseComposeYaml(yaml))).toEqual([]);
  });

  it("never writes pids_limit beside a deploy limits block, which Compose refuses", () => {
    const compose = parseCompose("services:\n  app:\n    image: nginx\n    pids_limit: 200\n    mem_limit: 1g\n");
    const raw = YAML.parse(composeToYaml(compose)) as { services: Record<string, Record<string, unknown>> };
    expect(raw.services.app.pids_limit).toBeUndefined();
    expect(raw.services.app.deploy).toEqual({ resources: { limits: { memory: "1g", pids: 200 } } });
  });

  it("leaves an explicit deploy limit alone", () => {
    const yaml = `services:
  app:
    image: nginx
    pids_limit: 200
    deploy:
      resources:
        limits:
          pids: 50
`;
    expect(parsedPids(yaml)).toBe(50);
  });
});

describe("buildVardoOverlay — cpu and pids precedence (#889)", () => {
  const keys = ["VARDO_DEFAULT_CPUS_STANDARD", "VARDO_DEFAULT_CPUS_DISPOSABLE", "VARDO_DEFAULT_PIDS_LIMIT"];
  const originals = keys.map((k) => process.env[k]);
  afterEach(() => {
    keys.forEach((k, i) => {
      if (originals[i] === undefined) delete process.env[k];
      else process.env[k] = originals[i];
    });
  });

  function limits(yaml: string, opts: { cpuLimit?: number | null; priority?: "critical" | "standard" | "disposable" } = {}) {
    const overlay = buildVardoOverlay({ fullCompose: parseCompose(yaml), networkName: NETWORK, hostCpus: 8, ...opts });
    return overlay.services.app.deploy?.resources?.limits;
  }
  const BARE = "services:\n  app:\n    image: nginx\n";

  it("sizes the tier default from the host", () => {
    expect(limits(BARE)?.cpus).toBe("7");
    expect(limits(BARE, { priority: "disposable" })?.cpus).toBe("4");
    expect(limits(BARE, { priority: "critical" })?.cpus).toBeUndefined();
    expect(defaultCpuLimit("standard", 1)).toBe(1);
    expect(defaultCpuLimit("disposable", 1)).toBe(1);
  });

  it("honors a compose cpus over the tier default", () => {
    expect(limits("services:\n  app:\n    image: nginx\n    cpus: 1.5\n")?.cpus).toBe("1.5");
  });

  it("honors a compose cpus of 0 as no cap", () => {
    expect(limits("services:\n  app:\n    image: nginx\n    cpus: 0\n")?.cpus).toBe("0");
  });

  it("puts the app's own limit over the compose", () => {
    expect(limits("services:\n  app:\n    image: nginx\n    cpus: 1.5\n", { cpuLimit: 3 })?.cpus).toBe("3");
  });

  it("honors a per-tier env override, 0 for none", () => {
    process.env.VARDO_DEFAULT_CPUS_STANDARD = "2";
    expect(limits(BARE)?.cpus).toBe("2");
    process.env.VARDO_DEFAULT_CPUS_STANDARD = "0";
    expect(limits(BARE)?.cpus).toBeUndefined();
  });

  it("caps processes by default and honors the compose's own value", () => {
    expect(limits(BARE)?.pids).toBe(defaultPidsLimit());
    expect(defaultPidsLimit()).toBe(4096);
    expect(limits("services:\n  app:\n    image: nginx\n    pids_limit: -1\n")?.pids).toBe(-1);
    expect(limits("services:\n  app:\n    image: nginx\n    pids_limit: 100\n")?.pids).toBe(100);
  });

  it("honors a pids env override, 0 for none, with a floor", () => {
    process.env.VARDO_DEFAULT_PIDS_LIMIT = "0";
    expect(limits(BARE)?.pids).toBeUndefined();
    process.env.VARDO_DEFAULT_PIDS_LIMIT = "8";
    expect(defaultPidsLimit()).toBe(64);
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
