// removeContainer({ volumes: true }) takes a container's anonymous volumes with it. Real Docker; skips without alpine.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { removeContainer } from "@/lib/docker/client";

const docker = (...argv: string[]) => execFileSync("docker", argv, { encoding: "utf8", timeout: 60_000 }).trim();

const READY = (() => {
  try {
    docker("image", "inspect", "alpine:latest");
    return true;
  } catch {
    return false;
  }
})();

// The client reads only DOCKER_HOST; point it at the CLI's context endpoint.
const HOST = process.env.DOCKER_HOST || (READY ? docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}") : "");

function leaveContainer(tag: string): { id: string; volume: string } {
  const id = docker("create", "--label", `vardo.test=${tag}`, "--mount", `type=volume,target=/data,volume-label=vardo.test=${tag}`, "alpine:latest", "true");
  return { id, volume: docker("volume", "ls", "-q", "--filter", `label=vardo.test=${tag}`) };
}

describe.skipIf(!READY)("removeContainer volumes option", () => {
  beforeAll(() => {
    vi.stubEnv("DOCKER_HOST", HOST);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("removes the anonymous volume only when asked", async () => {
    const keep = leaveContainer(`keep-${process.pid}`);
    const drop = leaveContainer(`drop-${process.pid}`);
    try {
      await removeContainer(keep.id, { force: true });
      await removeContainer(drop.id, { force: true, volumes: true });
      const left = docker("volume", "ls", "-q").split("\n");
      expect(left).toContain(keep.volume);
      expect(left).not.toContain(drop.volume);
    } finally {
      for (const c of [keep, drop]) {
        try {
          docker("rm", "-fv", c.id);
        } catch {}
        try {
          docker("volume", "rm", "-f", c.volume);
        } catch {}
      }
    }
  }, 60_000);
});
