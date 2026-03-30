import { describe, it, expect } from "vitest";
import {
  sanitizeCompose,
  parseCompose,
  injectNetwork,
  injectTraefikLabels,
  validateCompose,
  composeToYaml,
  injectGpuDevices,
  injectResourceLimits,
  generateComposeFromContainer,
  isAnonymousVolume,
  stripTraefikLabels,
  applyDeployTransforms,
  resolveBackendProtocol,
  narrowBackendProtocol,
  buildComposePreview,
  type ComposeFile,
  type ContainerConfig,
} from "@/lib/docker/compose";

function makeCompose(volumes: string[]): ComposeFile {
  return {
    services: {
      app: {
        name: "app",
        image: "nginx:latest",
        volumes,
      },
    },
  };
}

describe("sanitizeCompose", () => {
  describe("allowBindMounts disabled (default)", () => {
    it("passes named volumes through unchanged", () => {
      const compose = makeCompose(["data:/var/lib/data", "logs:/var/log/app"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual(["data:/var/lib/data", "logs:/var/log/app"]);
      expect(strippedMounts).toHaveLength(0);
    });

    it("strips absolute bind mounts", () => {
      const compose = makeCompose(["/home/user/data:/data"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual([]);
      expect(strippedMounts).toEqual(["app: /home/user/data:/data"]);
    });

    it("strips relative bind mounts (./)", () => {
      const compose = makeCompose(["./config:/etc/app/config"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual([]);
      expect(strippedMounts).toEqual(["app: ./config:/etc/app/config"]);
    });

    it("strips relative bind mounts (../)", () => {
      const compose = makeCompose(["../shared:/shared"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual([]);
      expect(strippedMounts).toHaveLength(1);
    });

    it("keeps named volumes and strips bind mounts together", () => {
      const compose = makeCompose(["data:/var/lib/data", "/tmp/uploads:/uploads"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual(["data:/var/lib/data"]);
      expect(strippedMounts).toEqual(["app: /tmp/uploads:/uploads"]);
    });
  });

  describe("allowBindMounts enabled", () => {
    it("passes safe bind mounts through", () => {
      const compose = makeCompose(["/home/user/data:/data"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose, { allowBindMounts: true });
      expect(result.services.app.volumes).toEqual(["/home/user/data:/data"]);
      expect(strippedMounts).toHaveLength(0);
    });

    it("passes named volumes through", () => {
      const compose = makeCompose(["data:/var/lib/data"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose, { allowBindMounts: true });
      expect(result.services.app.volumes).toEqual(["data:/var/lib/data"]);
      expect(strippedMounts).toHaveLength(0);
    });

    it("throws when mounting /etc", () => {
      const compose = makeCompose(["/etc:/host/etc"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path.*\/etc/,
      );
    });

    it("throws when mounting a subpath of /etc", () => {
      const compose = makeCompose(["/etc/nginx:/etc/nginx"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path/,
      );
    });

    it("throws when mounting /proc", () => {
      const compose = makeCompose(["/proc:/proc"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path/,
      );
    });

    it("throws when mounting /sys", () => {
      const compose = makeCompose(["/sys:/sys"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path/,
      );
    });

    it("throws when mounting /var/run/docker.sock", () => {
      const compose = makeCompose(["/var/run/docker.sock:/var/run/docker.sock"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path/,
      );
    });

    it("throws when mounting /root", () => {
      const compose = makeCompose(["/root:/root"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path/,
      );
    });

    it("resolves relative paths before checking deny list", () => {
      // A relative path that resolves into /proc should still be blocked.
      // process.cwd() in the test environment is unlikely to be /proc, so
      // we can only reliably test that safe relative paths pass through.
      const compose = makeCompose(["./uploads:/uploads"]);
      const { compose: result } = sanitizeCompose(compose, { allowBindMounts: true });
      expect(result.services.app.volumes).toEqual(["./uploads:/uploads"]);
    });

    it("blocks path traversal that resolves to a denied path", () => {
      // ../../../../../../etc traverses above the filesystem root and resolves
      // to /etc — the deny list must still catch it after resolve().
      const compose = makeCompose(["../../../../../../etc:/host/etc"]);
      expect(() => sanitizeCompose(compose, { allowBindMounts: true })).toThrow(
        /blocked host path/,
      );
    });
  });

  describe("anonymous volumes", () => {
    it("passes anonymous volumes through unchanged", () => {
      const compose = makeCompose(["/data"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual(["/data"]);
      expect(strippedMounts).toHaveLength(0);
    });

    it("passes anonymous volumes through even when bind mounts are disabled", () => {
      const compose = makeCompose(["/var/lib/postgresql/data"]);
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toEqual(["/var/lib/postgresql/data"]);
      expect(strippedMounts).toHaveLength(0);
    });
  });

  describe("services without volumes", () => {
    it("handles services with no volumes key", () => {
      const compose: ComposeFile = {
        services: {
          app: { name: "app", image: "nginx:latest" },
        },
      };
      const { compose: result, strippedMounts } = sanitizeCompose(compose);
      expect(result.services.app.volumes).toBeUndefined();
      expect(strippedMounts).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// parseCompose — network_mode
// ---------------------------------------------------------------------------

describe("parseCompose — network_mode", () => {
  it("parses host network mode", () => {
    const yaml = `
services:
  app:
    image: nginx
    network_mode: host
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.network_mode).toBe("host");
  });

  it("parses none network mode", () => {
    const yaml = `
services:
  app:
    image: nginx
    network_mode: none
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.network_mode).toBe("none");
  });

  it("parses bridge network mode", () => {
    const yaml = `
services:
  app:
    image: nginx
    network_mode: bridge
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.network_mode).toBe("bridge");
  });

  it("parses service:X network mode", () => {
    const yaml = `
services:
  openvpn:
    image: openvpn
  transmission:
    image: transmission
    network_mode: service:openvpn
`;
    const compose = parseCompose(yaml);
    expect(compose.services.transmission.network_mode).toBe("service:openvpn");
    expect(compose.services.openvpn.network_mode).toBeUndefined();
  });

  it("parses container:X network mode", () => {
    const yaml = `
services:
  app:
    image: nginx
    network_mode: container:my-container-123
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.network_mode).toBe("container:my-container-123");
  });

  it("silently drops unknown network modes", () => {
    const yaml = `
services:
  app:
    image: nginx
    network_mode: custom-plugin
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.network_mode).toBeUndefined();
  });

  it("preserves other service fields alongside network_mode", () => {
    const yaml = `
services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    network_mode: host
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.image).toBe("nginx:alpine");
    expect(compose.services.app.network_mode).toBe("host");
  });
});

// ---------------------------------------------------------------------------
// injectNetwork — skips services with network_mode
// ---------------------------------------------------------------------------

describe("injectNetwork — network_mode services", () => {
  it("skips adding vardo-network to services with network_mode", () => {
    const compose: ComposeFile = {
      services: {
        openvpn: { name: "openvpn", image: "openvpn" },
        transmission: { name: "transmission", image: "transmission", network_mode: "service:openvpn" },
      },
    };

    const result = injectNetwork(compose, "vardo-network");

    // openvpn gets the network
    expect(result.services.openvpn.networks).toContain("vardo-network");
    // transmission keeps its network_mode and doesn't get vardo-network
    expect(result.services.transmission.network_mode).toBe("service:openvpn");
    expect(result.services.transmission.networks).toBeUndefined();
  });

  it("skips vardo-network for host network mode", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", network_mode: "host" },
      },
    };

    const result = injectNetwork(compose, "vardo-network");

    expect(result.services.app.network_mode).toBe("host");
    expect(result.services.app.networks).toBeUndefined();
    // No vardo-network declared at top level since no service uses it
    expect(result.networks?.["vardo-network"]).toBeUndefined();
  });

  it("omits vardo-network top-level declaration when all services skip it", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", network_mode: "host" },
        sidecar: { name: "sidecar", image: "sidecar", network_mode: "none" },
      },
    };

    const result = injectNetwork(compose, "vardo-network");

    expect(result.networks?.["vardo-network"]).toBeUndefined();
  });

  it("declares vardo-network when at least one service uses it", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx" },
        sidecar: { name: "sidecar", image: "sidecar", network_mode: "service:app" },
      },
    };

    const result = injectNetwork(compose, "vardo-network");

    expect(result.networks?.["vardo-network"]).toEqual({ external: true });
    expect(result.services.app.networks).toContain("vardo-network");
    expect(result.services.sidecar.networks).toBeUndefined();
  });

  it("does not duplicate network on repeated calls", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx" },
      },
    };

    const once = injectNetwork(compose, "vardo-network");
    const twice = injectNetwork(once, "vardo-network");

    expect(twice.services.app.networks?.filter((n) => n === "vardo-network").length).toBe(1);
  });

  it("adds vardo-network alongside a named network from generateComposeFromContainer", () => {
    // Regression: containers on named Docker networks (e.g. vardo-network) had
    // their network set via network_mode, which caused injectNetwork to skip
    // the service. Fix: use networks array so injectNetwork can add vardo-network.
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "my-overlay" }));
    const result = injectNetwork(compose, "vardo-network");

    // Service must not have network_mode set — that would prevent injectNetwork from running.
    expect(result.services.myapp.network_mode).toBeUndefined();
    // Both the original named network and vardo-network should be present.
    expect(result.services.myapp.networks).toContain("my-overlay");
    expect(result.services.myapp.networks).toContain("vardo-network");
  });
});

// ---------------------------------------------------------------------------
// validateCompose — network_mode cross-references
// ---------------------------------------------------------------------------

describe("validateCompose — network_mode", () => {
  it("accepts valid service:X reference", () => {
    const compose: ComposeFile = {
      services: {
        openvpn: { name: "openvpn", image: "openvpn" },
        transmission: {
          name: "transmission",
          image: "transmission",
          network_mode: "service:openvpn",
        },
      },
    };

    const result = validateCompose(compose);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects service:X when X is not in the compose file", () => {
    const compose: ComposeFile = {
      services: {
        transmission: {
          name: "transmission",
          image: "transmission",
          network_mode: "service:openvpn",
        },
      },
    };

    const result = validateCompose(compose);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("openvpn") && e.includes("not defined"))).toBe(true);
  });

  it("rejects service: with empty service name", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", network_mode: "service:" },
      },
    };

    const result = validateCompose(compose);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("rejects self-referencing service:X", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", network_mode: "service:app" },
      },
    };

    const result = validateCompose(compose);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("itself"))).toBe(true);
  });

  it("accepts host, none, bridge without cross-reference checks", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", network_mode: "host" },
      },
    };

    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("accepts container:X without existence check (container may be external)", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", network_mode: "container:external-container" },
      },
    };

    const { valid } = validateCompose(compose);
    expect(valid).toBe(true);
  });

  it("rejects two-service circular chain (A → B → A)", () => {
    const compose: ComposeFile = {
      services: {
        a: { name: "a", image: "alpine", network_mode: "service:b" },
        b: { name: "b", image: "alpine", network_mode: "service:a" },
      },
    };

    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Circular") && e.includes("a") && e.includes("b"))).toBe(true);
  });

  it("rejects three-service circular chain (A → B → C → A)", () => {
    const compose: ComposeFile = {
      services: {
        a: { name: "a", image: "alpine", network_mode: "service:b" },
        b: { name: "b", image: "alpine", network_mode: "service:c" },
        c: { name: "c", image: "alpine", network_mode: "service:a" },
      },
    };

    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Circular"))).toBe(true);
    // Only one circular error reported, not three
    expect(errors.filter((e) => e.includes("Circular"))).toHaveLength(1);
  });

  it("rejects non-circular chaining (A → B → C, where C has no service: mode)", () => {
    const compose: ComposeFile = {
      services: {
        a: { name: "a", image: "alpine", network_mode: "service:b" },
        b: { name: "b", image: "alpine", network_mode: "service:c" },
        c: { name: "c", image: "alpine" },
      },
    };

    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(false);
    expect(
      errors.some((e) => e.includes('"a"') && e.includes('"b"') && e.includes("chaining")),
    ).toBe(true);
  });

  it("rejects each intermediate hop in a multi-level non-circular chain (A → B → C → D)", () => {
    const compose: ComposeFile = {
      services: {
        a: { name: "a", image: "alpine", network_mode: "service:b" },
        b: { name: "b", image: "alpine", network_mode: "service:c" },
        c: { name: "c", image: "alpine", network_mode: "service:d" },
        d: { name: "d", image: "alpine" },
      },
    };

    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(false);
    // a → b, and b uses service:c — a is invalid
    expect(errors.some((e) => e.includes('"a"') && e.includes('"b"') && e.includes("chaining"))).toBe(true);
    // b → c, and c uses service:d — b is invalid
    expect(errors.some((e) => e.includes('"b"') && e.includes('"c"') && e.includes("chaining"))).toBe(true);
    // c → d, and d has no service: mode — c is valid (not a chaining error)
    expect(errors.some((e) => e.includes('Service "c"') && e.includes("chaining"))).toBe(false);
  });

  it("accepts a valid multi-service layout without chaining", () => {
    const compose: ComposeFile = {
      services: {
        vpn: { name: "vpn", image: "openvpn" },
        torrent: { name: "torrent", image: "transmission", network_mode: "service:vpn" },
        proxy: { name: "proxy", image: "nginx", network_mode: "service:vpn" },
      },
    };

    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateCompose — anonymous volumes
// ---------------------------------------------------------------------------

describe("validateCompose — anonymous volumes", () => {
  it("accepts anonymous volumes (bare container paths) without flagging as bind mounts", () => {
    const compose: ComposeFile = {
      services: {
        db: { name: "db", image: "postgres:17", volumes: ["/var/lib/postgresql/data"] },
      },
    };
    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("still rejects bind mounts when allowBindMounts is false", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", volumes: ["/host/path:/data"] },
      },
    };
    const { valid, errors } = validateCompose(compose);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("bind mount"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCompose — skipMountChecks (trusted org bypass)
// ---------------------------------------------------------------------------

describe("validateCompose — skipMountChecks", () => {
  it("allows docker socket mount when skipMountChecks is true", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
      },
    };
    const { valid, errors } = validateCompose(compose, { skipMountChecks: true });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("allows /etc and /dev mounts when skipMountChecks is true", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", volumes: ["/etc:/host-etc", "/dev:/host-dev"] },
      },
    };
    const { valid, errors } = validateCompose(compose, { skipMountChecks: true });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("still rejects invalid service names when skipMountChecks is true", () => {
    const compose: ComposeFile = {
      services: {
        "Invalid-Service": { name: "Invalid-Service", image: "nginx", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
      },
    };
    const { valid, errors } = validateCompose(compose, { skipMountChecks: true });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Service name"))).toBe(true);
  });

  it("blocks denied paths when skipMountChecks is explicitly false", () => {
    const compose: ComposeFile = {
      services: {
        app: { name: "app", image: "nginx", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
      },
    };
    const { valid, errors } = validateCompose(compose, { skipMountChecks: false });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("bind mount"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeToYaml — round-trip with network_mode
// ---------------------------------------------------------------------------

describe("composeToYaml — network_mode round-trip", () => {
  it("serializes network_mode to YAML", () => {
    const compose: ComposeFile = {
      services: {
        openvpn: { name: "openvpn", image: "openvpn" },
        transmission: {
          name: "transmission",
          image: "transmission",
          network_mode: "service:openvpn",
        },
      },
    };

    const yaml = composeToYaml(compose);
    expect(yaml).toContain("network_mode: service:openvpn");
  });

  it("round-trips service:X network_mode through yaml", () => {
    const compose: ComposeFile = {
      services: {
        openvpn: { name: "openvpn", image: "openvpn" },
        transmission: {
          name: "transmission",
          image: "transmission",
          network_mode: "service:openvpn",
        },
      },
    };

    const yaml = composeToYaml(compose);
    const parsed = parseCompose(yaml);
    expect(parsed.services.transmission.network_mode).toBe("service:openvpn");
    expect(parsed.services.openvpn.network_mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// injectTraefikLabels — serviceName targeting
// ---------------------------------------------------------------------------

describe("injectTraefikLabels — serviceName", () => {
  const baseOpts = {
    projectName: "myapp",
    domain: "myapp.example.com",
    containerPort: 3000,
  };

  it("injects labels into the specified service, not the first", () => {
    const compose: ComposeFile = {
      services: {
        hostapp: { name: "hostapp", image: "plexinc/pms-docker", network_mode: "host" },
        web: { name: "web", image: "nginx" },
      },
    };

    const result = injectTraefikLabels(compose, { ...baseOpts, serviceName: "web" });

    // Labels go to the bridge-network service
    expect(result.services.web.labels?.["traefik.enable"]).toBe("true");
    // Host-network service is unchanged
    expect(result.services.hostapp.labels?.["traefik.enable"]).toBeUndefined();
    expect(result.services.hostapp.network_mode).toBe("host");
  });

  it("defaults to first service when serviceName is omitted", () => {
    const compose: ComposeFile = {
      services: {
        web: { name: "web", image: "nginx" },
        worker: { name: "worker", image: "node" },
      },
    };

    const result = injectTraefikLabels(compose, baseOpts);

    expect(result.services.web.labels?.["traefik.enable"]).toBe("true");
    expect(result.services.worker.labels?.["traefik.enable"]).toBeUndefined();
  });

  it("throws when serviceName references a service that does not exist", () => {
    const compose: ComposeFile = {
      services: {
        web: { name: "web", image: "nginx" },
      },
    };

    expect(() =>
      injectTraefikLabels(compose, { ...baseOpts, serviceName: "nonexistent" })
    ).toThrow('Service "nonexistent" not found');
  });
});

// ---------------------------------------------------------------------------
// primaryServiceName logic — service:X and container:X network modes
// ---------------------------------------------------------------------------

describe("injectTraefikLabels — service:X and container:X network modes", () => {
  const baseOpts = {
    projectName: "myapp",
    domain: "myapp.example.com",
    containerPort: 3000,
  };

  it("skips a service:X service and targets the first bridge-network service", () => {
    const compose: ComposeFile = {
      services: {
        vpn: { name: "vpn", image: "openvpn" },
        proxy: { name: "proxy", image: "nginx", network_mode: "service:vpn" },
        web: { name: "web", image: "node" },
      },
    };

    // Simulate the primaryServiceName logic from deploy.ts
    const primaryServiceName = Object.keys(compose.services).find(
      (k) => !compose.services[k].network_mode || compose.services[k].network_mode === "bridge"
    );

    expect(primaryServiceName).toBe("vpn");
    const result = injectTraefikLabels(compose, { ...baseOpts, serviceName: primaryServiceName });
    expect(result.services.vpn.labels?.["traefik.enable"]).toBe("true");
    expect(result.services.proxy.labels?.["traefik.enable"]).toBeUndefined();
    expect(result.services.web.labels?.["traefik.enable"]).toBeUndefined();
  });

  it("skips a container:X service and targets the first bridge-network service", () => {
    const compose: ComposeFile = {
      services: {
        db: { name: "db", image: "postgres" },
        sidecar: { name: "sidecar", image: "alpine", network_mode: "container:db" },
        api: { name: "api", image: "node" },
      },
    };

    const primaryServiceName = Object.keys(compose.services).find(
      (k) => !compose.services[k].network_mode || compose.services[k].network_mode === "bridge"
    );

    expect(primaryServiceName).toBe("db");
    const result = injectTraefikLabels(compose, { ...baseOpts, serviceName: primaryServiceName });
    expect(result.services.db.labels?.["traefik.enable"]).toBe("true");
    expect(result.services.sidecar.labels?.["traefik.enable"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// injectGpuDevices
// ---------------------------------------------------------------------------

const baseCompose = (): ComposeFile => ({
  services: {
    app: {
      name: "app",
      image: "myapp:latest",
    },
  },
});

describe("injectGpuDevices", () => {
  it("adds nvidia gpu reservation to a service", () => {
    const result = injectGpuDevices(baseCompose());
    const devices = result.services.app.deploy?.resources?.reservations?.devices;
    expect(devices).toHaveLength(1);
    expect(devices?.[0]).toMatchObject({
      driver: "nvidia",
      count: "all",
      capabilities: ["gpu"],
    });
  });

  it("does not duplicate gpu entry when already present", () => {
    const compose: ComposeFile = {
      services: {
        app: {
          name: "app",
          image: "myapp:latest",
          deploy: {
            resources: {
              reservations: {
                devices: [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }],
              },
            },
          },
        },
      },
    };
    const result = injectGpuDevices(compose);
    const devices = result.services.app.deploy?.resources?.reservations?.devices;
    expect(devices).toHaveLength(1);
  });

  it("preserves existing deploy resource limits when injecting gpu", () => {
    const compose: ComposeFile = {
      services: {
        app: {
          name: "app",
          image: "myapp:latest",
          deploy: {
            resources: {
              limits: { cpus: "2", memory: "1024M" },
            },
          },
        },
      },
    };
    const result = injectGpuDevices(compose);
    expect(result.services.app.deploy?.resources?.limits).toEqual({
      cpus: "2",
      memory: "1024M",
    });
    const devices = result.services.app.deploy?.resources?.reservations?.devices;
    expect(devices).toHaveLength(1);
    expect(devices?.[0].capabilities).toContain("gpu");
  });

  it("does not mutate the original compose", () => {
    const original = baseCompose();
    injectGpuDevices(original);
    expect(original.services.app.deploy).toBeUndefined();
  });

  it("injects gpu into every service", () => {
    const compose: ComposeFile = {
      services: {
        web: { name: "web", image: "web:latest" },
        worker: { name: "worker", image: "worker:latest" },
      },
    };
    const result = injectGpuDevices(compose);
    for (const svc of Object.values(result.services)) {
      const devices = svc.deploy?.resources?.reservations?.devices;
      expect(devices).toHaveLength(1);
      expect(devices?.[0].capabilities).toContain("gpu");
    }
  });
});

describe("injectResourceLimits", () => {
  it("adds cpu and memory limits", () => {
    const result = injectResourceLimits(baseCompose(), { cpuLimit: 1.5, memoryLimit: 512 });
    expect(result.services.app.deploy?.resources?.limits).toEqual({
      cpus: "1.5",
      memory: "512M",
    });
  });

  it("returns unchanged compose when no limits provided", () => {
    const original = baseCompose();
    const result = injectResourceLimits(original, {});
    expect(result).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// parseCompose — extended field round-trips
// ---------------------------------------------------------------------------

describe("parseCompose — extended fields", () => {
  it("normalises env_file from scalar string to array", () => {
    const yaml = `
services:
  app:
    image: nginx
    env_file: .env
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.env_file).toEqual([".env"]);
  });

  it("omits privileged and init when explicitly false", () => {
    const yaml = `
services:
  app:
    image: nginx
    privileged: false
    init: false
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.privileged).toBeUndefined();
    expect(compose.services.app.init).toBeUndefined();
  });

  it("normalises tmpfs from scalar string to array", () => {
    const yaml = `
services:
  app:
    image: nginx
    tmpfs: /run
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.tmpfs).toEqual(["/run"]);
  });

  it("parses ulimits in both single-value and soft/hard object forms", () => {
    const yaml = `
services:
  app:
    image: nginx
    ulimits:
      nproc: 65535
      nofile:
        soft: 1024
        hard: 65536
`;
    const compose = parseCompose(yaml);
    expect(compose.services.app.ulimits?.nproc).toBe(65535);
    expect(compose.services.app.ulimits?.nofile).toEqual({ soft: 1024, hard: 65536 });
  });

  it("round-trips all extended fields through yaml", () => {
    const original: ComposeFile = {
      services: {
        app: {
          name: "app",
          image: "nginx:alpine",
          restart: "unless-stopped",
          env_file: [".env"],
          cap_add: ["NET_ADMIN"],
          cap_drop: ["ALL"],
          privileged: true,
          security_opt: ["no-new-privileges:true"],
          shm_size: "128m",
          init: true,
          extra_hosts: ["host.docker.internal:host-gateway"],
          hostname: "custom-host",
          user: "1000:1000",
          stop_signal: "SIGINT",
          entrypoint: ["/entrypoint.sh"],
          command: ["start"],
          tmpfs: ["/run"],
          ulimits: { nofile: { soft: 1024, hard: 65536 } },
        },
      },
    };

    const yaml = composeToYaml(original);
    const parsed = parseCompose(yaml);
    const svc = parsed.services.app;

    expect(svc.restart).toBe("unless-stopped");
    expect(svc.env_file).toEqual([".env"]);
    expect(svc.cap_add).toEqual(["NET_ADMIN"]);
    expect(svc.cap_drop).toEqual(["ALL"]);
    expect(svc.privileged).toBe(true);
    expect(svc.security_opt).toEqual(["no-new-privileges:true"]);
    expect(svc.shm_size).toBe("128m");
    expect(svc.init).toBe(true);
    expect(svc.extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
    expect(svc.hostname).toBe("custom-host");
    expect(svc.user).toBe("1000:1000");
    expect(svc.stop_signal).toBe("SIGINT");
    expect(svc.entrypoint).toEqual(["/entrypoint.sh"]);
    expect(svc.command).toEqual(["start"]);
    expect(svc.tmpfs).toEqual(["/run"]);
    expect(svc.ulimits?.nofile).toEqual({ soft: 1024, hard: 65536 });
  });
});

// ---------------------------------------------------------------------------
// generateComposeFromContainer
// ---------------------------------------------------------------------------

function makeContainerConfig(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  return {
    image: "nginx:latest",
    ports: [],
    mounts: [],
    networkMode: "bridge",
    restartPolicy: "unless-stopped",
    capAdd: [],
    capDrop: [],
    devices: [],
    privileged: false,
    securityOpt: [],
    shmSize: 0,
    init: false,
    extraHosts: [],
    nanoCpus: 0,
    memoryBytes: 0,
    ulimits: [],
    tmpfs: [],
    hostname: "",
    user: "",
    stopSignal: "",
    healthcheck: null,
    entrypoint: [],
    command: [],
    labels: {},
    hasEnvVars: false,
    ...overrides,
  };
}

describe("generateComposeFromContainer", () => {
  it("produces image and restart fields", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig());
    const svc = compose.services.myapp;
    expect(svc.image).toBe("nginx:latest");
    expect(svc.restart).toBe("unless-stopped");
  });

  it("defaults restart to unless-stopped when container had none", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ restartPolicy: "no" }));
    expect(compose.services.myapp.restart).toBe("unless-stopped");
  });

  it("preserves on-failure:N restart policy", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ restartPolicy: "on-failure:3" }));
    expect(compose.services.myapp.restart).toBe("on-failure:3");
  });

  it("preserves always restart policy", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ restartPolicy: "always" }));
    expect(compose.services.myapp.restart).toBe("always");
  });

  it("adds env_file when hasEnvVars is true", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ hasEnvVars: true }));
    expect(compose.services.myapp.env_file).toEqual([".env"]);
  });

  it("omits env_file when hasEnvVars is false", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ hasEnvVars: false }));
    expect(compose.services.myapp.env_file).toBeUndefined();
  });

  it("maps external ports", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ports: [{ internal: 8080, external: 8080, protocol: "tcp" }],
    }));
    expect(compose.services.myapp.ports).toEqual(["8080:8080"]);
  });

  it("omits protocol suffix for tcp ports", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ports: [{ internal: 53, external: 53, protocol: "tcp" }],
    }));
    expect(compose.services.myapp.ports).toEqual(["53:53"]);
  });

  it("includes protocol suffix for non-tcp ports", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ports: [{ internal: 53, external: 53, protocol: "udp" }],
    }));
    expect(compose.services.myapp.ports).toEqual(["53:53/udp"]);
  });

  it("skips ports that are not externally mapped", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ports: [{ internal: 8080, protocol: "tcp" }],
    }));
    expect(compose.services.myapp.ports).toBeUndefined();
  });

  it("includes named volumes and declares them at top level", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      mounts: [{ name: "mydata", source: "/var/lib/docker/volumes/mydata/_data", destination: "/data", type: "volume" }],
    }));
    expect(compose.services.myapp.volumes).toContain("mydata:/data");
    expect(compose.volumes?.mydata).toBeDefined();
  });

  it("emits anonymous volumes as bare container paths and omits top-level declaration", () => {
    const anonHash = "a".repeat(64);
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      mounts: [{ name: anonHash, source: `/var/lib/docker/volumes/${anonHash}/_data`, destination: "/data", type: "volume" }],
    }));
    expect(compose.services.myapp.volumes).toContain("/data");
    expect(compose.services.myapp.volumes).not.toContain(`${anonHash}:/data`);
    expect(compose.volumes).toBeUndefined();
  });

  it("handles mixed named and anonymous volumes", () => {
    const anonHash = "b".repeat(64);
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      mounts: [
        { name: "mydata", source: "/var/lib/docker/volumes/mydata/_data", destination: "/data", type: "volume" },
        { name: anonHash, source: `/var/lib/docker/volumes/${anonHash}/_data`, destination: "/tmp/cache", type: "volume" },
      ],
    }));
    expect(compose.services.myapp.volumes).toContain("mydata:/data");
    expect(compose.services.myapp.volumes).toContain("/tmp/cache");
    expect(compose.volumes?.mydata).toBeDefined();
    expect(compose.volumes?.[anonHash]).toBeUndefined();
  });

  it("includes bind mounts inline without a top-level declaration", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      mounts: [{ name: "", source: "/host/path", destination: "/data", type: "bind" }],
    }));
    expect(compose.services.myapp.volumes).toContain("/host/path:/data");
    expect(compose.volumes).toBeUndefined();
  });

  it("sets network_mode for host networking", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "host" }));
    expect(compose.services.myapp.network_mode).toBe("host");
  });

  it("sets network_mode for none networking", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "none" }));
    expect(compose.services.myapp.network_mode).toBe("none");
  });

  it("sets network_mode for container: networking", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "container:abc123" }));
    expect(compose.services.myapp.network_mode).toBe("container:abc123");
    expect(compose.services.myapp.networks).toBeUndefined();
  });

  it("sets network_mode for service: networking", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "service:vpn" }));
    expect(compose.services.myapp.network_mode).toBe("service:vpn");
    expect(compose.services.myapp.networks).toBeUndefined();
  });

  it("omits network_mode for bridge networking", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "bridge" }));
    expect(compose.services.myapp.network_mode).toBeUndefined();
  });

  it("uses networks array (not network_mode) for named Docker networks", () => {
    // Regression: named networks were incorrectly set as network_mode, which
    // caused injectNetwork to skip the service so it never joined vardo-network.
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "vardo-network" }));
    expect(compose.services.myapp.network_mode).toBeUndefined();
    expect(compose.services.myapp.networks).toEqual(["vardo-network"]);
  });

  it("declares named networks as external in the top-level networks section", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "my-overlay" }));
    expect(compose.networks).toBeDefined();
    expect(compose.networks!["my-overlay"]).toEqual({ external: true });
  });

  it("network declarations from multiple containers can be merged for group import", () => {
    // Regression: group import merged services and volumes but not network
    // declarations. Containers on named Docker networks had their top-level
    // network declarations silently dropped, causing Docker Compose to fail.
    const a = generateComposeFromContainer("svc-a", makeContainerConfig({ networkMode: "overlay-1" }));
    const b = generateComposeFromContainer("svc-b", makeContainerConfig({ networkMode: "overlay-2" }));

    // Simulate the merge loop from the group import route
    const merged: ComposeFile = { services: {} };
    for (const file of [a, b]) {
      for (const [name, svc] of Object.entries(file.services)) {
        merged.services[name] = svc;
      }
      if (file.networks) {
        merged.networks ??= {};
        for (const [netName, netDef] of Object.entries(file.networks)) {
          (merged.networks as Record<string, unknown>)[netName] = netDef;
        }
      }
    }

    expect(merged.networks).toBeDefined();
    expect((merged.networks as Record<string, unknown>)["overlay-1"]).toEqual({ external: true });
    expect((merged.networks as Record<string, unknown>)["overlay-2"]).toEqual({ external: true });
  });

  it("does not add default network_mode for omitted networkMode", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ networkMode: "default" }));
    expect(compose.services.myapp.network_mode).toBeUndefined();
    expect(compose.services.myapp.networks).toBeUndefined();
  });

  it("includes capabilities", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      capAdd: ["NET_ADMIN", "SYS_PTRACE"],
      capDrop: ["ALL"],
    }));
    expect(compose.services.myapp.cap_add).toEqual(["NET_ADMIN", "SYS_PTRACE"]);
    expect(compose.services.myapp.cap_drop).toEqual(["ALL"]);
  });

  it("includes devices", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      devices: [{ hostPath: "/dev/snd", containerPath: "/dev/snd", permissions: "rwm" }],
    }));
    // Default permissions (rwm) are omitted for brevity
    expect(compose.services.myapp.devices).toEqual(["/dev/snd:/dev/snd"]);
  });

  it("includes non-default device permissions", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      devices: [{ hostPath: "/dev/snd", containerPath: "/dev/snd", permissions: "r" }],
    }));
    expect(compose.services.myapp.devices).toEqual(["/dev/snd:/dev/snd:r"]);
  });

  it("includes privileged flag", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ privileged: true }));
    expect(compose.services.myapp.privileged).toBe(true);
  });

  it("omits privileged when false", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ privileged: false }));
    expect(compose.services.myapp.privileged).toBeUndefined();
  });

  it("includes security_opt", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      securityOpt: ["no-new-privileges:true"],
    }));
    expect(compose.services.myapp.security_opt).toEqual(["no-new-privileges:true"]);
  });

  it("includes non-default shm_size", () => {
    // 128 MiB = 128 * 1024 * 1024 bytes
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      shmSize: 128 * 1024 * 1024,
    }));
    expect(compose.services.myapp.shm_size).toBe("128m");
  });

  it("omits shm_size at the Docker default (64 MiB)", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      shmSize: 64 * 1024 * 1024,
    }));
    expect(compose.services.myapp.shm_size).toBeUndefined();
  });

  it("includes init flag", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ init: true }));
    expect(compose.services.myapp.init).toBe(true);
  });

  it("includes extra_hosts", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      extraHosts: ["myhost:192.168.1.10"],
    }));
    expect(compose.services.myapp.extra_hosts).toEqual(["myhost:192.168.1.10"]);
  });

  it("includes resource limits from container HostConfig", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      nanoCpus: 500_000_000, // 0.5 CPUs
      memoryBytes: 256 * 1024 * 1024, // 256 MiB
    }));
    expect(compose.services.myapp.deploy?.resources?.limits?.cpus).toBe("0.5");
    expect(compose.services.myapp.deploy?.resources?.limits?.memory).toBe("256m");
  });

  it("omits deploy block when no resource limits are set", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig());
    expect(compose.services.myapp.deploy).toBeUndefined();
  });

  it("includes ulimits with matching soft/hard as single value", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ulimits: [{ name: "nproc", soft: 65535, hard: 65535 }],
    }));
    expect(compose.services.myapp.ulimits?.nproc).toBe(65535);
  });

  it("includes ulimits with differing soft/hard as object", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ulimits: [{ name: "nofile", soft: 1024, hard: 65536 }],
    }));
    expect(compose.services.myapp.ulimits?.nofile).toEqual({ soft: 1024, hard: 65536 });
  });

  it("includes tmpfs mounts", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      tmpfs: ["/run", "/tmp"],
    }));
    expect(compose.services.myapp.tmpfs).toEqual(["/run", "/tmp"]);
  });

  it("includes custom hostname but not a container-id hostname", () => {
    const customCompose = generateComposeFromContainer("myapp", makeContainerConfig({
      hostname: "my-custom-host",
    }));
    expect(customCompose.services.myapp.hostname).toBe("my-custom-host");

    // 12-char hex looks like a Docker-assigned container ID — skip it
    const autoCompose = generateComposeFromContainer("myapp", makeContainerConfig({
      hostname: "a1b2c3d4e5f6",
    }));
    expect(autoCompose.services.myapp.hostname).toBeUndefined();
  });

  it("includes user", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ user: "1000:1000" }));
    expect(compose.services.myapp.user).toBe("1000:1000");
  });

  it("includes non-default stop_signal", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ stopSignal: "SIGINT" }));
    expect(compose.services.myapp.stop_signal).toBe("SIGINT");
  });

  it("omits stop_signal when it is the default SIGTERM", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({ stopSignal: "SIGTERM" }));
    expect(compose.services.myapp.stop_signal).toBeUndefined();
  });

  it("includes healthcheck with duration strings", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      healthcheck: {
        test: ["CMD", "curl", "-f", "http://localhost/"],
        interval: 30_000_000_000, // 30s in nanoseconds
        timeout: 10_000_000_000,  // 10s
        retries: 3,
        startPeriod: 0,
      },
    }));
    const hc = compose.services.myapp.healthcheck;
    expect(hc?.test).toEqual(["CMD", "curl", "-f", "http://localhost/"]);
    expect(hc?.interval).toBe("30s");
    expect(hc?.timeout).toBe("10s");
    expect(hc?.retries).toBe(3);
    expect(hc?.start_period).toBeUndefined();
  });

  it("includes entrypoint and command", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      entrypoint: ["/entrypoint.sh"],
      command: ["start", "--verbose"],
    }));
    expect(compose.services.myapp.entrypoint).toEqual(["/entrypoint.sh"]);
    expect(compose.services.myapp.command).toEqual(["start", "--verbose"]);
  });

  it("strips OCI and Docker metadata labels, keeps only traefik. and vardo. prefixed", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      labels: {
        // OCI image metadata — should be stripped
        "maintainer": "OpenSpeedTest.com <support@OpenSpeedTest.com>",
        "org.opencontainers.image.created": "2025-01-06T01:05:14.577Z",
        "org.opencontainers.image.description": "Unprivileged NGINX Dockerfiles",
        // Docker Compose internals — should be stripped
        "com.docker.compose.project": "myproject",
        // Other arbitrary labels — should be stripped
        "host.project": "myapp",
        "my.custom.label": "value",
        "app.version": "1.2.3",
        // Allowed prefixes — should be kept
        "traefik.enable": "true",
        "traefik.http.routers.foo.rule": "Host(`example.com`)",
        "vardo.custom": "meta",
      },
    }));
    const labels = compose.services.myapp.labels ?? {};
    expect(labels["maintainer"]).toBeUndefined();
    expect(labels["org.opencontainers.image.created"]).toBeUndefined();
    expect(labels["org.opencontainers.image.description"]).toBeUndefined();
    expect(labels["com.docker.compose.project"]).toBeUndefined();
    expect(labels["host.project"]).toBeUndefined();
    expect(labels["my.custom.label"]).toBeUndefined();
    expect(labels["app.version"]).toBeUndefined();
    expect(labels["traefik.enable"]).toBe("true");
    expect(labels["traefik.http.routers.foo.rule"]).toBe("Host(`example.com`)");
    expect(labels["vardo.custom"]).toBe("meta");
  });

  it("omits labels block when no allowed labels are present", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      labels: {
        "com.docker.compose.project": "myproject",
        "org.opencontainers.image.title": "My App",
        "maintainer": "someone",
      },
    }));
    expect(compose.services.myapp.labels).toBeUndefined();
  });

  it("produced compose round-trips through yaml cleanly", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      ports: [{ internal: 8080, external: 8080, protocol: "tcp" }],
      mounts: [{ name: "data", source: "/var/lib/docker/volumes/data/_data", destination: "/data", type: "volume" }],
      capAdd: ["NET_ADMIN"],
      restartPolicy: "unless-stopped",
      hasEnvVars: true,
    }));

    const yaml = composeToYaml(compose);
    const parsed = parseCompose(yaml);
    const svc = parsed.services.myapp;

    expect(svc.image).toBe("nginx:latest");
    expect(svc.restart).toBe("unless-stopped");
    expect(svc.ports).toEqual(["8080:8080"]);
    expect(svc.volumes).toContain("data:/data");
    expect(svc.cap_add).toEqual(["NET_ADMIN"]);
    expect(svc.env_file).toEqual([".env"]);
    expect(parsed.volumes?.data).toBeDefined();
  });

  it("bind mounts survive yaml round-trip and sanitize when allowBindMounts is true", () => {
    // Regression: deploy.ts was regenerating compose from generateComposeForImage for
    // image-type apps, silently dropping the bind mounts captured at import time.
    // Now it uses the stored composeContent — this test verifies the full path.
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      mounts: [
        { name: "", source: "/host/data", destination: "/data", type: "bind" },
        { name: "namedvol", source: "/var/lib/docker/volumes/namedvol/_data", destination: "/vol", type: "volume" },
      ],
    }));

    const yaml = composeToYaml(compose);
    const parsed = parseCompose(yaml);
    const { compose: sanitized, strippedMounts } = sanitizeCompose(parsed, { allowBindMounts: true });

    expect(strippedMounts).toHaveLength(0);
    expect(sanitized.services.myapp.volumes).toContain("/host/data:/data");
    expect(sanitized.services.myapp.volumes).toContain("namedvol:/vol");
  });

  it("bind mounts are stripped by sanitize when allowBindMounts is false", () => {
    const compose = generateComposeFromContainer("myapp", makeContainerConfig({
      mounts: [
        { name: "", source: "/host/data", destination: "/data", type: "bind" },
        { name: "namedvol", source: "/var/lib/docker/volumes/namedvol/_data", destination: "/vol", type: "volume" },
      ],
    }));

    const yaml = composeToYaml(compose);
    const parsed = parseCompose(yaml);
    const { compose: sanitized, strippedMounts } = sanitizeCompose(parsed, { allowBindMounts: false });

    expect(strippedMounts).toHaveLength(1);
    expect(sanitized.services.myapp.volumes).not.toContain("/host/data:/data");
    expect(sanitized.services.myapp.volumes).toContain("namedvol:/vol");
  });
});

// ---------------------------------------------------------------------------
// isAnonymousVolume — anonymous volume detection
// ---------------------------------------------------------------------------

describe("isAnonymousVolume", () => {
  it("returns true for an empty name", () => {
    // Docker sets Name to "" for volumes that have no explicit name field.
    expect(isAnonymousVolume("")).toBe(true);
  });

  it("returns true for a 64-character lowercase hex hash", () => {
    // Docker assigns a hex hash as the volume name for anonymous volumes.
    const hash = "a1b2c3d4".repeat(8); // 64 chars
    expect(isAnonymousVolume(hash)).toBe(true);
  });

  it("returns false for a short human-readable volume name", () => {
    expect(isAnonymousVolume("data")).toBe(false);
    expect(isAnonymousVolume("postgres")).toBe(false);
  });

  it("returns false for a namespaced volume name (project_volume)", () => {
    expect(isAnonymousVolume("myapp-blue_data")).toBe(false);
    expect(isAnonymousVolume("myapp-green_postgres")).toBe(false);
  });

  it("returns false for a 63-character hex string (one short of a Docker hash)", () => {
    const almostHash = "a".repeat(63);
    expect(isAnonymousVolume(almostHash)).toBe(false);
  });

  it("returns false for a 65-character hex string (one over a Docker hash)", () => {
    const tooLong = "a".repeat(65);
    expect(isAnonymousVolume(tooLong)).toBe(false);
  });

  it("returns false for a 64-char string with uppercase letters (not a Docker hash)", () => {
    const upperHash = "A".repeat(64);
    expect(isAnonymousVolume(upperHash)).toBe(false);
  });
});

describe("stripTraefikLabels", () => {
  it("strips all traefik.* labels from a single service", () => {
    const compose: ComposeFile = {
      services: {
        app: {
          name: "app",
          image: "nginx:latest",
          labels: {
            "traefik.enable": "true",
            "traefik.http.routers.app.rule": "Host(`example.com`)",
            "vardo.managed": "true",
          },
        },
      },
    };
    const result = stripTraefikLabels(compose);
    expect(result.services.app.labels).toEqual({ "vardo.managed": "true" });
  });

  it("leaves services with no labels unchanged", () => {
    const compose: ComposeFile = {
      services: {
        app: {
          name: "app",
          image: "nginx:latest",
        },
      },
    };
    const result = stripTraefikLabels(compose);
    expect(result.services.app.labels).toBeUndefined();
  });

  it("strips traefik.* labels from each service independently in a multi-service compose", () => {
    const compose: ComposeFile = {
      services: {
        web: {
          name: "web",
          image: "nginx:latest",
          labels: {
            "traefik.enable": "true",
            "traefik.http.routers.web.rule": "Host(`example.com`)",
            "vardo.managed": "true",
          },
        },
        db: {
          name: "db",
          image: "postgres:15",
          labels: {
            "vardo.managed": "true",
          },
        },
        cache: {
          name: "cache",
          image: "redis:7",
          labels: {
            "traefik.enable": "false",
            "com.example.custom": "keep",
          },
        },
      },
    };
    const result = stripTraefikLabels(compose);
    expect(result.services.web.labels).toEqual({ "vardo.managed": "true" });
    expect(result.services.db.labels).toEqual({ "vardo.managed": "true" });
    expect(result.services.cache.labels).toEqual({ "com.example.custom": "keep" });
  });
});

// ---------------------------------------------------------------------------
// applyDeployTransforms
// ---------------------------------------------------------------------------

function makeSimpleCompose(): ComposeFile {
  return {
    services: {
      app: {
        name: "app",
        image: "nginx:latest",
      },
    },
  };
}

const baseTransformOpts = {
  appName: "myapp",
  containerPort: 3000,
  cpuLimit: null,
  memoryLimit: null,
  gpuEnabled: false,
  domains: [] as { id: string; domain: string; port: number | null; sslEnabled: boolean | null; certResolver: string | null; redirectTo: string | null; redirectCode: number | null }[],
  networkName: "vardo-network",
};

describe("applyDeployTransforms — network injection", () => {
  it("injects the vardo network into all services", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), baseTransformOpts);
    expect(result.services.app.networks).toContain("vardo-network");
    expect(result.networks?.["vardo-network"]).toBeDefined();
  });
});

describe("applyDeployTransforms — resource limits", () => {
  it("does not inject resource limits when both are null", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      cpuLimit: null,
      memoryLimit: null,
    });
    expect(result.services.app.deploy?.resources).toBeUndefined();
  });

  it("injects CPU limit when cpuLimit is set", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      cpuLimit: 2,
      memoryLimit: null,
    });
    expect(result.services.app.deploy?.resources?.limits?.cpus).toBe("2");
  });

  it("injects memory limit when memoryLimit is set", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      cpuLimit: null,
      memoryLimit: 512,
    });
    expect(result.services.app.deploy?.resources?.limits?.memory).toBe("512M");
  });
});

describe("applyDeployTransforms — GPU devices", () => {
  it("does not inject GPU devices when gpuEnabled is false", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      gpuEnabled: false,
    });
    expect(result.services.app.deploy?.resources?.reservations?.devices).toBeUndefined();
  });

  it("injects GPU device reservation when gpuEnabled is true", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      gpuEnabled: true,
    });
    const devices = result.services.app.deploy?.resources?.reservations?.devices;
    expect(devices).toBeDefined();
    expect(devices?.[0]?.capabilities).toContain("gpu");
  });
});

describe("applyDeployTransforms — Traefik labels", () => {
  it("injects Traefik labels for each domain", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      domains: [
        {
          id: "dom-aabbccdd",
          domain: "example.com",
          port: null,
          sslEnabled: true,
          certResolver: "le",
          redirectTo: null,
          redirectCode: null,
        },
      ],
    });
    const labels = result.services.app.labels as Record<string, string> | undefined;
    expect(labels).toBeDefined();
    const labelStr = JSON.stringify(labels);
    expect(labelStr).toContain("traefik");
    expect(labelStr).toContain("example.com");
  });

  it("does not inject Traefik labels when there are no domains", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      domains: [],
    });
    // stripTraefikLabels removes existing labels; no new ones are injected
    expect(result.services.app.labels).toBeUndefined();
  });

  it("injects HTTPS backend labels when backendProtocol is https", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      ...baseTransformOpts,
      appName: "myapp",
      backendProtocol: "https",
      domains: [
        {
          id: "dom-aabbccdd",
          domain: "example.com",
          port: null,
          sslEnabled: false,
          certResolver: null,
          redirectTo: null,
          redirectCode: null,
        },
      ],
    });
    const labels = result.services.app.labels as Record<string, string> | undefined;
    expect(labels).toBeDefined();
    expect(labels!["traefik.http.services.myapp.loadbalancer.server.scheme"]).toBe("https");
    expect(labels!["traefik.http.services.myapp.loadbalancer.serversTransport"]).toBe(
      "myapp-insecure@file",
    );
  });
});

describe("applyDeployTransforms — combined transforms", () => {
  it("applies all transforms in sequence: limits, GPU, labels, network", () => {
    const result = applyDeployTransforms(makeSimpleCompose(), {
      appName: "fullapp",
      containerPort: 8080,
      cpuLimit: 1,
      memoryLimit: 256,
      gpuEnabled: true,
      domains: [
        {
          id: "dom-00112233",
          domain: "full.example.com",
          port: null,
          sslEnabled: false,
          certResolver: null,
          redirectTo: null,
          redirectCode: null,
        },
      ],
      networkName: "vardo-network",
    });

    // Resource limits applied
    expect(result.services.app.deploy?.resources?.limits?.cpus).toBe("1");
    expect(result.services.app.deploy?.resources?.limits?.memory).toBe("256M");

    // GPU devices applied
    expect(result.services.app.deploy?.resources?.reservations?.devices).toBeDefined();

    // Traefik labels injected
    const labels = result.services.app.labels as Record<string, string> | undefined;
    expect(JSON.stringify(labels)).toContain("traefik");

    // Network injected
    expect(result.services.app.networks).toContain("vardo-network");
  });
});

// ---------------------------------------------------------------------------
// resolveBackendProtocol
// ---------------------------------------------------------------------------

describe("resolveBackendProtocol", () => {
  it("returns 'https' when backendProtocol is explicitly 'https'", () => {
    expect(resolveBackendProtocol("https", 3000)).toBe("https");
  });

  it("returns 'http' when backendProtocol is explicitly 'http'", () => {
    expect(resolveBackendProtocol("http", 443)).toBe("http");
  });

  it("auto-detects https for port 443 when backendProtocol is null", () => {
    expect(resolveBackendProtocol(null, 443)).toBe("https");
  });

  it("auto-detects https for port 8443 when backendProtocol is null", () => {
    expect(resolveBackendProtocol(null, 8443)).toBe("https");
  });

  it("auto-detects http for port 3000 when backendProtocol is null", () => {
    expect(resolveBackendProtocol(null, 3000)).toBe("http");
  });

  it("auto-detects http for port 80 when backendProtocol is null", () => {
    expect(resolveBackendProtocol(null, 80)).toBe("http");
  });

  it("auto-detects http when backendProtocol is undefined", () => {
    expect(resolveBackendProtocol(undefined, 3000)).toBe("http");
  });

  it("auto-detects https when backendProtocol is undefined and port is 443", () => {
    expect(resolveBackendProtocol(undefined, 443)).toBe("https");
  });
});

// ---------------------------------------------------------------------------
// narrowBackendProtocol
// ---------------------------------------------------------------------------

describe("narrowBackendProtocol", () => {
  it("returns 'http' for 'http'", () => {
    expect(narrowBackendProtocol("http")).toBe("http");
  });

  it("returns 'https' for 'https'", () => {
    expect(narrowBackendProtocol("https")).toBe("https");
  });

  it("returns null for null", () => {
    expect(narrowBackendProtocol(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(narrowBackendProtocol(undefined)).toBeNull();
  });

  it("returns null for an unexpected string value", () => {
    expect(narrowBackendProtocol("ftp")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(narrowBackendProtocol("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// injectTraefikLabels — HTTPS backend
// ---------------------------------------------------------------------------

describe("injectTraefikLabels — HTTPS backend", () => {
  const baseComposeFn = (): ComposeFile => ({
    services: {
      app: { name: "app", image: "myimage:latest" },
    },
  });

  const baseOpts = {
    projectName: "myapp",
    appName: "myapp",
    domain: "myapp.example.com",
    containerPort: 443,
  };

  it("sets server scheme to https and serversTransport when backendProtocol is https", () => {
    const result = injectTraefikLabels(baseComposeFn(), {
      ...baseOpts,
      backendProtocol: "https",
    });
    const labels = result.services.app.labels as Record<string, string>;
    expect(labels["traefik.http.services.myapp.loadbalancer.server.scheme"]).toBe("https");
    expect(labels["traefik.http.services.myapp.loadbalancer.serversTransport"]).toBe("myapp-insecure@file");
  });

  it("does not set https scheme when backendProtocol is http", () => {
    const result = injectTraefikLabels(baseComposeFn(), {
      ...baseOpts,
      backendProtocol: "http",
    });
    const labels = result.services.app.labels as Record<string, string>;
    expect(labels["traefik.http.services.myapp.loadbalancer.server.scheme"]).toBeUndefined();
    expect(labels["traefik.http.services.myapp.loadbalancer.serversTransport"]).toBeUndefined();
  });

  it("does not set https scheme when backendProtocol is omitted", () => {
    const result = injectTraefikLabels(baseComposeFn(), baseOpts);
    const labels = result.services.app.labels as Record<string, string>;
    expect(labels["traefik.http.services.myapp.loadbalancer.server.scheme"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildComposePreview — trusted org bind mount handling
// ---------------------------------------------------------------------------

const BASE_PREVIEW_APP = {
  name: "myapp",
  deployType: "compose" as const,
  imageName: null,
  containerPort: 3000,
  cpuLimit: null,
  memoryLimit: null,
  gpuEnabled: false,
  exposedPorts: null,
  domains: [],
  backendProtocol: null as "http" | "https" | null,
};

describe("buildComposePreview", () => {
  const networkName = "vardo-network";

  it("strips bind mounts in preview when allowBindMounts is false", () => {
    const compose = `
services:
  app:
    image: nginx:latest
    volumes:
      - /home/user/data:/data
      - named-vol:/app/data
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      false,
      false,
    );
    expect(result).not.toBeNull();
    expect(result!.services.app.volumes).not.toContain("/home/user/data:/data");
    expect(result!.services.app.volumes).toContain("named-vol:/app/data");
  });

  it("preserves safe bind mounts in preview when allowBindMounts is true", () => {
    const compose = `
services:
  app:
    image: nginx:latest
    volumes:
      - /home/user/data:/data
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      false,
      true,
    );
    expect(result).not.toBeNull();
    expect(result!.services.app.volumes).toContain("/home/user/data:/data");
  });

  it("returns null for a denied bind mount path when allowBindMounts is true", () => {
    const compose = `
services:
  app:
    image: myimage:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      false,
      true,
    );
    expect(result).toBeNull();
  });

  it("preserves denied bind mount paths for trusted orgs", () => {
    const compose = `
services:
  app:
    image: myimage:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      true,
      true,
    );
    expect(result).not.toBeNull();
    expect(result!.services.app.volumes).toContain(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
  });

  it("preserves /etc bind mounts for trusted orgs", () => {
    const compose = `
services:
  app:
    image: myimage:latest
    volumes:
      - /etc/myconfig:/etc/myconfig:ro
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      true,
      true,
    );
    expect(result).not.toBeNull();
    expect(result!.services.app.volumes).toContain("/etc/myconfig:/etc/myconfig:ro");
  });

  it("preserves multiple denied bind mounts for trusted orgs", () => {
    const compose = `
services:
  app:
    image: myimage:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /proc:/host/proc:ro
      - data:/app/data
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      true,
      true,
    );
    expect(result).not.toBeNull();
    const vols = result!.services.app.volumes ?? [];
    expect(vols).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(vols).toContain("/proc:/host/proc:ro");
    expect(vols).toContain("data:/app/data");
  });

  it("applies deploy transforms (network injection) for trusted org preview", () => {
    const compose = `
services:
  app:
    image: myimage:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;
    const result = buildComposePreview(
      { ...BASE_PREVIEW_APP, composeContent: compose },
      [],
      networkName,
      true,
      true,
    );
    expect(result).not.toBeNull();
    // Network should be injected by applyDeployTransforms
    expect(result!.networks).toBeDefined();
  });
});
