// removeContainer({ volumes: true }) takes a container's anonymous volumes with it. Real Docker; skips without alpine.

import { describe, it, expect } from "vitest";
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

function leaveContainer(tag: string): { id: string; volume: string } {
  const id = docker("create", "--label", `vardo.test=${tag}`, "--mount", `type=volume,target=/data,volume-label=vardo.test=${tag}`, "alpine:latest", "true");
  return { id, volume: docker("volume", "ls", "-q", "--filter", `label=vardo.test=${tag}`) };
}

describe.skipIf(!READY)("removeContainer volumes option", () => {
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
      docker("volume", "rm", "-f", keep.volume);
    }
  });
});
