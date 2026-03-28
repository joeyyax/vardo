import { describe, it, expect } from "vitest";
import { sanitizeCompose } from "@/lib/docker/compose";
import type { ComposeFile } from "@/lib/docker/compose";

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
