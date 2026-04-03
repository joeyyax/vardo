import { describe, it, expect } from "vitest";
import { analyzeCompose, analyzeRawCompose } from "@/lib/docker/compose-analyze";
import type { ComposeFile } from "@/lib/docker/compose";

function makeCompose(overrides?: Partial<Record<string, unknown>>): ComposeFile {
  return {
    services: {
      app: {
        name: "app",
        image: "nginx:latest",
        ports: ["8080:3000"],
        environment: { NODE_ENV: "production", SECRET: "hunter2" },
        ...overrides,
      },
    },
  } as ComposeFile;
}

describe("analyzeCompose", () => {
  describe("host ports", () => {
    it("flags host ports on routed services as auto-fixed", () => {
      const compose = makeCompose();
      const result = analyzeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      const portFindings = result.findings.filter((f) => f.category === "host-port");
      expect(portFindings).toHaveLength(1);
      expect(portFindings[0].autoFixed).toBe(true);
      expect(portFindings[0].severity).toBe("info");
    });

    it("warns about host ports on non-routed services with common HTTP ports", () => {
      const compose = makeCompose();
      const result = analyzeCompose(compose, {
        routedServices: new Set(),
      });

      const portFindings = result.findings.filter((f) => f.category === "host-port");
      expect(portFindings).toHaveLength(1);
      expect(portFindings[0].autoFixed).toBe(false);
      expect(portFindings[0].severity).toBe("warning");
    });

    it("does not flag internal-only port declarations", () => {
      const compose = makeCompose({ ports: ["3000"] });
      const result = analyzeCompose(compose);

      const portFindings = result.findings.filter((f) => f.category === "host-port");
      expect(portFindings).toHaveLength(0);
    });

    it("does not flag non-HTTP ports on non-routed services", () => {
      const compose = makeCompose({ ports: ["5432:5432"] }); // non-standard port
      const result = analyzeCompose(compose);

      const portFindings = result.findings.filter((f) => f.category === "host-port");
      expect(portFindings).toHaveLength(0);
    });

    it("skips port analysis entirely for known non-HTTP services", () => {
      const compose: ComposeFile = {
        services: {
          db: {
            name: "db",
            image: "postgres:16",
            ports: ["5432:5432"],
          },
          cache: {
            name: "cache",
            image: "redis:7-alpine",
            ports: ["6379:6379"],
          },
        },
      };
      const result = analyzeCompose(compose, {
        routedServices: new Set(["db", "cache"]), // even if marked as routed
      });

      const portFindings = result.findings.filter((f) => f.category === "host-port");
      expect(portFindings).toHaveLength(0);
    });

    it("still flags HTTP services even when mixed with non-HTTP", () => {
      const compose: ComposeFile = {
        services: {
          app: { name: "app", image: "nginx:latest", ports: ["8080:3000"] },
          db: { name: "db", image: "mysql:8", ports: ["3306:3306"] },
        },
      };
      const result = analyzeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      const portFindings = result.findings.filter((f) => f.category === "host-port");
      expect(portFindings).toHaveLength(1);
      expect(portFindings[0].service).toBe("app");
    });
  });

  describe("restart policy", () => {
    it("flags missing restart policy", () => {
      const compose = makeCompose({ restart: undefined });
      const result = analyzeCompose(compose);

      const restartFindings = result.findings.filter((f) => f.category === "restart-policy");
      expect(restartFindings).toHaveLength(1);
      expect(restartFindings[0].autoFixed).toBe(true);
    });

    it('flags restart: "no"', () => {
      const compose = makeCompose({ restart: "no" });
      const result = analyzeCompose(compose);

      const restartFindings = result.findings.filter((f) => f.category === "restart-policy");
      expect(restartFindings).toHaveLength(1);
      expect(restartFindings[0].severity).toBe("warning");
    });

    it('does not flag "unless-stopped"', () => {
      const compose = makeCompose({ restart: "unless-stopped" });
      const result = analyzeCompose(compose);

      const restartFindings = result.findings.filter((f) => f.category === "restart-policy");
      expect(restartFindings).toHaveLength(0);
    });
  });

  describe("inline environment variables", () => {
    it("identifies inline env vars as extraction candidates", () => {
      const compose = makeCompose();
      const result = analyzeCompose(compose);

      const envFindings = result.findings.filter((f) => f.category === "inline-env");
      expect(envFindings).toHaveLength(2); // NODE_ENV and SECRET
      expect(envFindings.every((f) => f.severity === "info")).toBe(true);
    });

    it("warns when inline env var conflicts with managed key", () => {
      const compose = makeCompose();
      const result = analyzeCompose(compose, {
        managedEnvKeys: new Set(["NODE_ENV"]),
      });

      const envFindings = result.findings.filter((f) => f.category === "inline-env");
      const managed = envFindings.find((f) => f.detail.key === "NODE_ENV");
      expect(managed?.severity).toBe("warning");
      expect(managed?.detail.managed).toBe(true);
    });

    it("skips variable references", () => {
      const compose = makeCompose({
        environment: { DB_URL: "${DATABASE_URL}", PORT: "3000" },
      });
      const result = analyzeCompose(compose);

      const envFindings = result.findings.filter((f) => f.category === "inline-env");
      expect(envFindings).toHaveLength(1); // Only PORT, not DB_URL
      expect(envFindings[0].detail.key).toBe("PORT");
    });
  });

  describe("counts", () => {
    it("provides accurate counts by category", () => {
      const compose = makeCompose();
      const result = analyzeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      expect(result.counts["host-port"]).toBe(1);
      expect(result.counts["inline-env"]).toBe(2);
    });
  });
});

describe("analyzeRawCompose", () => {
  it("detects container_name in raw YAML", () => {
    const yaml = `
services:
  app:
    image: nginx:latest
    container_name: my-custom-name
`;
    const result = analyzeRawCompose(yaml);
    const nameFindings = result.findings.filter((f) => f.category === "container-name");
    expect(nameFindings).toHaveLength(1);
    expect(nameFindings[0].detail.containerName).toBe("my-custom-name");
  });
});
