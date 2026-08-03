import { describe, it, expect } from "vitest";
import { normalizeCompose, getRoutedServices } from "@/lib/docker/compose-normalize";
import { analyzeCompose } from "@/lib/docker/compose-analyze";
import type { ComposeFile } from "@/lib/docker/compose";

function makeCompose(services?: Record<string, Partial<ComposeFile["services"][string]>>): ComposeFile {
  return {
    services: Object.fromEntries(
      Object.entries(services ?? {
        app: { name: "app", image: "nginx:latest", ports: ["8080:3000"] },
      }).map(([name, svc]) => [name, { name, ...svc }])
    ),
  };
}

describe("normalizeCompose", () => {
  describe("host port stripping", () => {
    it("strips host ports from routed services", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000", "3000"], restart: "unless-stopped" },
      });

      const { compose: result, changes } = normalizeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      expect(result.services.app.ports).toEqual(["3000"]);
      const portChanges = changes.filter((c) => c.field === "ports");
      expect(portChanges).toHaveLength(1);
      expect(portChanges[0].action).toBe("removed");
    });

    it("removes ports array entirely when all are host-bound", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000"] },
      });

      const { compose: result } = normalizeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      expect(result.services.app.ports).toBeUndefined();
    });

    it("does not strip ports from non-routed services", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000"] },
        db: { image: "postgres:16", ports: ["5432:5432"] },
      });

      const { compose: result } = normalizeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      expect(result.services.db.ports).toEqual(["5432:5432"]);
    });

    it("respects keepHostPorts option", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000"] },
      });

      const { compose: result, changes } = normalizeCompose(compose, {
        routedServices: new Set(["app"]),
        keepHostPorts: true,
      });

      expect(result.services.app.ports).toEqual(["8080:3000"]);
      expect(changes.filter((c) => c.field === "ports")).toHaveLength(0);
    });
  });

  describe("restart policy normalization", () => {
    it("adds restart policy when missing", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest" },
      });

      const { compose: result, changes } = normalizeCompose(compose, {
        routedServices: new Set(),
      });

      expect(result.services.app.restart).toBe("unless-stopped");
      expect(changes.find((c) => c.field === "restart")?.action).toBe("added");
    });

    it('changes restart: "no" to unless-stopped', () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", restart: "no" },
      });

      const { compose: result, changes } = normalizeCompose(compose, {
        routedServices: new Set(),
      });

      expect(result.services.app.restart).toBe("unless-stopped");
      expect(changes.find((c) => c.field === "restart")?.action).toBe("changed");
    });

    it("uses custom restart policy when specified", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest" },
      });

      const { compose: result } = normalizeCompose(compose, {
        routedServices: new Set(),
        restartPolicy: "on-failure",
      });

      expect(result.services.app.restart).toBe("on-failure");
    });

    it('downgrades "always" to "unless-stopped" even as the target policy', () => {
      const compose = makeCompose({
        app: { image: "nginx:latest" },
      });

      const { compose: result } = normalizeCompose(compose, {
        routedServices: new Set(),
        restartPolicy: "always",
      });

      expect(result.services.app.restart).toBe("unless-stopped");
    });

    it('leaves "on-failure" alone and downgrades a declared "always"', () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", restart: "on-failure" },
        db: { image: "postgres:16", restart: "always" },
      });

      const { compose: result, changes } = normalizeCompose(compose, {
        routedServices: new Set(),
      });

      expect(result.services.app.restart).toBe("on-failure");
      // "always" resurrects a stopped standby when the daemon restarts.
      expect(result.services.db.restart).toBe("unless-stopped");
      expect(changes.filter((c) => c.field === "restart")).toHaveLength(1);
    });
  });

  describe("restart precedence (app column vs compose vs default)", () => {
    const restartOf = (
      svc: Partial<ComposeFile["services"][string]>,
      restartPolicy?: string | null,
    ) =>
      normalizeCompose(makeCompose({ app: { image: "nginx:latest", ...svc } }), {
        keepHostPorts: true,
        restartPolicy,
      }).compose.services.app.restart;

    it("uses the default when neither compose nor the column says anything", () => {
      expect(restartOf({}, null)).toBe("unless-stopped");
    });

    it("fills a service that declares nothing from the app column", () => {
      expect(restartOf({}, "on-failure")).toBe("on-failure");
    });

    it("keeps a service's own policy over the app column", () => {
      expect(restartOf({ restart: "on-failure:3" }, "unless-stopped")).toBe("on-failure:3");
    });

    it('overrides a declared "no" with the app column', () => {
      expect(restartOf({ restart: "no" }, "unless-stopped")).toBe("unless-stopped");
    });

    it('honors a declared "no" when the column also says "no"', () => {
      expect(restartOf({ restart: "no" }, "no")).toBe("no");
    });

    it('never emits "always", from the compose file or the column', () => {
      expect(restartOf({ restart: "always" }, "unless-stopped")).toBe("unless-stopped");
      expect(restartOf({}, "always")).toBe("unless-stopped");
    });

    it("falls back to the default when the column holds a value Docker rejects", () => {
      expect(restartOf({}, "sometimes")).toBe("unless-stopped");
    });

    it("records no change when the column matches what the service declares", () => {
      const { changes } = normalizeCompose(
        makeCompose({ app: { image: "nginx:latest", restart: "no" } }),
        { keepHostPorts: true, restartPolicy: "no" },
      );
      expect(changes.filter((c) => c.field === "restart")).toHaveLength(0);
    });

    it("applies the column to every service independently", () => {
      const compose = makeCompose({
        web: { image: "nginx:latest" },
        db: { image: "postgres:17", restart: "no" },
        job: { image: "job:latest", restart: "on-failure" },
      });

      const { compose: result } = normalizeCompose(compose, {
        keepHostPorts: true,
        restartPolicy: "unless-stopped",
      });

      expect(result.services.web.restart).toBe("unless-stopped");
      expect(result.services.db.restart).toBe("unless-stopped");
      expect(result.services.job.restart).toBe("on-failure");
    });
  });

  describe("changelog", () => {
    it("returns empty changes when nothing to normalize", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", restart: "unless-stopped" },
      });

      const { changes } = normalizeCompose(compose, {
        routedServices: new Set(),
      });

      expect(changes).toHaveLength(0);
    });

    it("records multiple changes across services", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["3000:3000"] },
        worker: { image: "worker:latest" }, // missing restart
      });

      const { changes } = normalizeCompose(compose, {
        routedServices: new Set(["app"]),
      });

      // port strip from app + restart add for app + restart add for worker
      expect(changes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("omitted routedServices", () => {
    it("treats all services as non-routed when routedServices is omitted", () => {
      // resolve-compose.ts calls normalizeCompose(compose, { keepHostPorts: true })
      // without routedServices — exercises the `?? new Set()` fallback.
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000"] },
      });

      const { compose: result, changes } = normalizeCompose(compose, { keepHostPorts: true });

      // With keepHostPorts the port should be retained (no routed services to strip from anyway)
      expect(result.services.app.ports).toEqual(["8080:3000"]);
      // restart policy should still be normalised
      expect(result.services.app.restart).toBe("unless-stopped");
      expect(changes.filter((c) => c.field === "ports")).toHaveLength(0);
    });
  });

  describe("immutability", () => {
    it("does not modify the original compose object", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000"] },
      });

      const originalPorts = [...(compose.services.app.ports ?? [])];
      normalizeCompose(compose, { routedServices: new Set(["app"]) });

      expect(compose.services.app.ports).toEqual(originalPorts);
    });
  });

  describe("round-trip", () => {
    it("analyze after normalize produces zero auto-fixable findings", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", ports: ["8080:3000", "3000"] },
        worker: { image: "worker:latest" },
      });

      const routedServices = new Set(["app"]);
      const { compose: normalized } = normalizeCompose(compose, { routedServices });
      const analysis = analyzeCompose(normalized, { routedServices });

      const autoFixable = analysis.findings.filter((f) => f.autoFixed);
      expect(autoFixable).toHaveLength(0);
    });
  });

  describe("getRoutedServices", () => {
    it("returns primary bridge-network service when domains exist", () => {
      const compose = makeCompose({
        app: { image: "nginx:latest" },
        db: { image: "postgres:16" },
      });

      const routed = getRoutedServices(compose, 2);
      expect(routed).toEqual(new Set(["app"]));
    });

    it("returns empty set when no domains", () => {
      const compose = makeCompose({ app: { image: "nginx:latest" } });
      const routed = getRoutedServices(compose, 0);
      expect(routed).toEqual(new Set());
    });

    it("skips services with custom network_mode", () => {
      const compose: ComposeFile = {
        services: {
          vpn: { name: "vpn", image: "wireguard", network_mode: "host" },
          app: { name: "app", image: "nginx:latest" },
        },
      };
      const routed = getRoutedServices(compose, 1);
      expect(routed).toEqual(new Set(["app"]));
    });
  });
});
