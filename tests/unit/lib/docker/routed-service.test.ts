import { describe, it, expect } from "vitest";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";
import {
  selectRoutedService,
  declaredContainerPorts,
  type RoutedServiceReason,
} from "@/lib/docker/routed-service";

function compose(services: Record<string, Partial<ComposeService>>): ComposeFile {
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, svc]) => [name, { name, ...svc }]),
    ),
  };
}

/**
 * Authentik's compose lists the worker before the server. Both run the same
 * image; only the server serves 9000.
 */
function authentikCompose(): ComposeFile {
  return compose({
    "authentik-worker": {
      image: "ghcr.io/goauthentik/server:2024.10",
      command: "worker",
    },
    "authentik-server": {
      image: "ghcr.io/goauthentik/server:2024.10",
      command: "server",
      ports: ["9000:9000", "9443:9443"],
    },
    postgresql: { image: "postgres:16-alpine" },
    redis: { image: "redis:alpine" },
  });
}

describe("declaredContainerPorts", () => {
  const cases: { name: string; svc: Partial<ComposeService>; expected: number[] }[] = [
    { name: "no ports", svc: {}, expected: [] },
    { name: "container port only", svc: { ports: ["3000"] }, expected: [3000] },
    { name: "host:container", svc: { ports: ["8080:3000"] }, expected: [3000] },
    { name: "ip:host:container", svc: { ports: ["127.0.0.1:8080:3000"] }, expected: [3000] },
    { name: "protocol suffix", svc: { ports: ["8080:3000/tcp"] }, expected: [3000] },
    { name: "expose", svc: { expose: ["9000"] }, expected: [9000] },
    { name: "ports and expose", svc: { ports: ["80:8080"], expose: ["9000"] }, expected: [8080, 9000] },
    { name: "unparseable entries dropped", svc: { ports: ["[object Object]"] }, expected: [] },
  ];

  for (const { name, svc, expected } of cases) {
    it(name, () => {
      expect(declaredContainerPorts({ name: "svc", ...svc })).toEqual(expected);
    });
  }
});

describe("selectRoutedService", () => {
  describe("explicit override", () => {
    it("wins over every other signal", () => {
      const result = selectRoutedService(authentikCompose(), {
        containerPort: 9000,
        override: "authentik-worker",
      });
      expect(result).toEqual({ service: "authentik-worker", reason: "override" });
    });

    it("is ignored when the named service is absent", () => {
      const result = selectRoutedService(authentikCompose(), {
        containerPort: 9000,
        override: "does-not-exist",
      });
      expect(result.service).toBe("authentik-server");
    });
  });

  describe("regression: authentik routes to the server, not the worker", () => {
    it("picks the service that publishes the app port", () => {
      const result = selectRoutedService(authentikCompose(), { containerPort: 9000 });
      expect(result).toEqual({ service: "authentik-server", reason: "declared-port" });
    });

    it("picks the server when both list the port and only the name disambiguates", () => {
      const both = authentikCompose();
      both.services["authentik-worker"].ports = ["9000"];
      const result = selectRoutedService(both, { containerPort: 9000 });
      expect(result).toEqual({ service: "authentik-server", reason: "role" });
    });

    it("picks the server from image ports when neither declares any", () => {
      const bare = authentikCompose();
      delete bare.services["authentik-server"].ports;
      const result = selectRoutedService(bare, {
        containerPort: 9000,
        imagePorts: { "authentik-server": [9000], postgresql: [5432], redis: [6379] },
      });
      expect(result).toEqual({ service: "authentik-server", reason: "image-port" });
    });

    it("falls back to the worker only when nothing at all disambiguates", () => {
      const bare = compose({
        "authentik-worker": { image: "ghcr.io/example/app:1" },
        "authentik-server": { image: "ghcr.io/example/app:1" },
      });
      const result = selectRoutedService(bare, { containerPort: 9000 });
      expect(result.service).toBe("authentik-server");
      expect(result.reason).toBe("role");
    });
  });

  describe("signal precedence", () => {
    const table: {
      name: string;
      compose: ComposeFile;
      containerPort?: number | null;
      imagePorts?: Record<string, number[]>;
      expected: string | undefined;
      reason: RoutedServiceReason;
    }[] = [
      {
        name: "single service wins before any other signal",
        compose: compose({ postgres: { image: "postgres:17" } }),
        containerPort: 3000,
        expected: "postgres",
        reason: "sole-candidate",
      },
      {
        name: "declared port beats compose order",
        compose: compose({
          db: { image: "postgres:17", ports: ["5432:5432"] },
          web: { image: "nginx", ports: ["8080:3000"] },
        }),
        containerPort: 3000,
        expected: "web",
        reason: "declared-port",
      },
      {
        name: "expose counts as a declaration",
        compose: compose({
          worker: { image: "ghcr.io/example/app:1" },
          api: { image: "ghcr.io/example/app:1", expose: ["8000"] },
        }),
        containerPort: 8000,
        expected: "api",
        reason: "declared-port",
      },
      {
        name: "declared port beats image port",
        compose: compose({
          a: { image: "ghcr.io/example/a:1" },
          b: { image: "ghcr.io/example/b:1", ports: ["3000"] },
        }),
        containerPort: 3000,
        imagePorts: { a: [3000] },
        expected: "b",
        reason: "declared-port",
      },
      {
        name: "image port used when no service declares one",
        compose: compose({
          cache: { image: "ghcr.io/example/cache:1" },
          web: { image: "ghcr.io/example/web:1" },
        }),
        containerPort: 8080,
        imagePorts: { cache: [11211], web: [8080] },
        expected: "web",
        reason: "image-port",
      },
      {
        name: "datastore images demoted when nothing else disambiguates",
        compose: compose({
          postgres: { image: "postgres:17" },
          app: { image: "ghcr.io/example/app:1" },
        }),
        containerPort: 3000,
        expected: "app",
        reason: "role",
      },
      {
        name: "registry-prefixed datastore images are recognized",
        compose: compose({
          db: { image: "docker.io/library/mariadb:11" },
          app: { image: "ghcr.io/example/app:1" },
        }),
        containerPort: 3000,
        expected: "app",
        reason: "role",
      },
      {
        name: "a datastore-only stack keeps compose order",
        compose: compose({
          postgres: { image: "postgres:17" },
          redis: { image: "redis:7" },
        }),
        containerPort: 5432,
        expected: "postgres",
        reason: "file-order",
      },
      {
        name: "port match on a datastore still wins over the role filter",
        compose: compose({
          app: { image: "ghcr.io/example/app:1" },
          postgres: { image: "postgres:17", ports: ["5432:5432"] },
        }),
        containerPort: 5432,
        expected: "postgres",
        reason: "declared-port",
      },
      {
        name: "host network services cannot be routed",
        compose: compose({
          probe: { image: "ghcr.io/example/probe:1", network_mode: "host" },
          web: { image: "nginx" },
        }),
        containerPort: 80,
        expected: "web",
        reason: "sole-candidate",
      },
      {
        name: "explicit bridge mode stays a candidate",
        compose: compose({
          web: { image: "nginx", network_mode: "bridge", ports: ["80"] },
          worker: { image: "nginx", network_mode: "bridge" },
        }),
        containerPort: 80,
        expected: "web",
        reason: "declared-port",
      },
      {
        name: "no routable service at all",
        compose: compose({ probe: { image: "nginx", network_mode: "host" } }),
        containerPort: 80,
        expected: undefined,
        reason: "file-order",
      },
      {
        name: "missing container port falls through to the role filter",
        compose: compose({
          redis: { image: "redis:7" },
          web: { image: "nginx", ports: ["8080:80"] },
        }),
        containerPort: null,
        expected: "web",
        reason: "role",
      },
    ];

    for (const row of table) {
      it(row.name, () => {
        const result = selectRoutedService(row.compose, {
          containerPort: row.containerPort,
          imagePorts: row.imagePorts,
        });
        expect(result.service).toBe(row.expected);
        expect(result.reason).toBe(row.reason);
      });
    }
  });

  describe("ambiguity reporting", () => {
    it("names the tied services and picks the first", () => {
      const result = selectRoutedService(
        compose({
          api: { image: "ghcr.io/example/app:1" },
          admin: { image: "ghcr.io/example/app:1" },
        }),
        { containerPort: 3000 },
      );
      expect(result).toEqual({
        service: "api",
        reason: "file-order",
        ambiguous: ["api", "admin"],
      });
    });

    it("reports only the services that survived narrowing", () => {
      const result = selectRoutedService(
        compose({
          postgres: { image: "postgres:17" },
          api: { image: "ghcr.io/example/app:1" },
          admin: { image: "ghcr.io/example/app:1" },
        }),
        { containerPort: 3000 },
      );
      expect(result.ambiguous).toEqual(["api", "admin"]);
    });

    it("is unset when a signal identified the service", () => {
      const result = selectRoutedService(authentikCompose(), { containerPort: 9000 });
      expect(result.ambiguous).toBeUndefined();
    });
  });

  describe("background role names", () => {
    const demoted = ["worker", "app-worker", "celery", "celery-beat", "scheduler", "cron", "db-migrate", "queue-consumer", "init"];
    for (const name of demoted) {
      it(`demotes "${name}"`, () => {
        const result = selectRoutedService(
          compose({ [name]: { image: "ghcr.io/example/app:1" }, web: { image: "ghcr.io/example/app:1" } }),
          { containerPort: 3000 },
        );
        expect(result.service).toBe("web");
      });
    }

    const kept = ["networker", "coworkers", "api", "frontend", "server"];
    for (const name of kept) {
      it(`does not demote "${name}"`, () => {
        const result = selectRoutedService(
          compose({ [name]: { image: "ghcr.io/example/app:1" }, other: { image: "ghcr.io/example/app:1" } }),
          { containerPort: 3000 },
        );
        expect(result.ambiguous).toEqual([name, "other"]);
      });
    }
  });
});
