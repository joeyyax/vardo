import { describe, it, expect } from "vitest";
import { parseContainerId } from "@/lib/metrics/cadvisor";

const ID = "00ebd1bf8075d6dd1da83a4a6625a334beeb0dab1a62ca738db8997b35be6aa5";

describe("parseContainerId", () => {
  it("reads the id out of a systemd cgroup v2 scope", () => {
    expect(parseContainerId(`/system.slice/docker-${ID}.scope`)).toBe(ID.slice(0, 12));
  });

  it("reads the id out of a cgroup v1 docker path", () => {
    expect(parseContainerId(`/docker/${ID}`)).toBe(ID.slice(0, 12));
  });

  it("handles a nested kubepods-style path", () => {
    expect(parseContainerId(`/kubepods/besteffort/pod123/${ID}`)).toBe(ID.slice(0, 12));
  });

  it("matches what Docker's list API reports, truncated", () => {
    // The whole point: this value is joined against container.id elsewhere.
    expect(parseContainerId(`/system.slice/docker-${ID}.scope`)).toBe(ID.slice(0, 12));
  });

  it("falls back to the last segment when there is no hex id", () => {
    expect(parseContainerId("/system.slice/some-other.scope")).toBe("some-other.s");
  });

  it("returns empty for an empty path", () => {
    expect(parseContainerId("")).toBe("");
  });
});
