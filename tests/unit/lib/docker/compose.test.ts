import { describe, it, expect } from "vitest";
import {
  sanitizeCompose,
  parseCompose,
  injectNetwork,
  validateCompose,
  composeToYaml,
  type ComposeFile,
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

  it("rejects unknown network modes", () => {
    const yaml = `
services:
  app:
    image: nginx
    network_mode: custom-plugin
`;
    const compose = parseCompose(yaml);
    // Unknown modes are silently dropped during parse
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
    expect(compose.services.app.restart).toBeUndefined(); // restart not parsed
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
