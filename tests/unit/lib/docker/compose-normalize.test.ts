import { describe, it, expect } from "vitest";
import { normalizeCompose } from "@/lib/docker/compose-normalize";
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
        restartPolicy: "always",
      });

      expect(result.services.app.restart).toBe("always");
    });

    it('leaves "on-failure" and "always" alone', () => {
      const compose = makeCompose({
        app: { image: "nginx:latest", restart: "on-failure" },
        db: { image: "postgres:16", restart: "always" },
      });

      const { compose: result, changes } = normalizeCompose(compose, {
        routedServices: new Set(),
      });

      expect(result.services.app.restart).toBe("on-failure");
      expect(result.services.db.restart).toBe("always");
      expect(changes.filter((c) => c.field === "restart")).toHaveLength(0);
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
});
