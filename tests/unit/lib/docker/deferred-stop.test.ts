import { describe, expect, it } from "vitest";
import {
  DEFERRED_STOP_DELAY_SECONDS,
  deferredStopArgs,
  parseContainerIds,
} from "@/lib/docker/deferred-stop";

describe("parseContainerIds", () => {
  it("reads one id per line from compose ps -q", () => {
    expect(parseContainerIds("abc123\ndef456\n")).toEqual(["abc123", "def456"]);
  });

  it("is empty for a project with nothing running", () => {
    expect(parseContainerIds("\n  \n")).toEqual([]);
  });
});

describe("deferredStopArgs", () => {
  it("runs detached so it outlives the process being stopped", () => {
    const args = deferredStopArgs(["abc123"])!;
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
  });

  it("mounts the docker socket, without which it cannot stop anything", () => {
    expect(deferredStopArgs(["abc123"])).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("waits before stopping, so post-deploy bookkeeping lands first", () => {
    const args = deferredStopArgs(["abc123"])!;
    expect(args[args.length - 1]).toBe(`sleep ${DEFERRED_STOP_DELAY_SECONDS}; docker stop abc123`);
  });

  it("stops every container in the old slot", () => {
    const args = deferredStopArgs(["abc123", "def456"])!;
    expect(args[args.length - 1]).toContain("docker stop abc123 def456");
  });

  it("returns null when there is nothing to stop, so no container is spawned", () => {
    expect(deferredStopArgs([])).toBeNull();
    expect(deferredStopArgs(["", "  "])).toBeNull();
  });

  it("takes an explicit delay", () => {
    const args = deferredStopArgs(["abc"], 5)!;
    expect(args[args.length - 1]).toBe("sleep 5; docker stop abc");
  });
});
