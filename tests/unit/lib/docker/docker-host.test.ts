import { describe, it, expect } from "vitest";
import { parseDockerHost } from "@/lib/docker/client";

describe("parseDockerHost", () => {
  it("defaults to the standard socket", () => {
    expect(parseDockerHost(undefined)).toEqual({ socketPath: "/var/run/docker.sock" });
  });

  it("connects through a unix:// socket path", () => {
    expect(parseDockerHost("unix:///run/user/1000/docker.sock")).toEqual({
      socketPath: "/run/user/1000/docker.sock",
    });
  });

  it("rejects a unix:// value with no path", () => {
    expect(() => parseDockerHost("unix://")).toThrow(/no socket path/);
  });

  it("reads host and port from tcp://", () => {
    expect(parseDockerHost("tcp://10.0.0.5:2376")).toEqual({ host: "10.0.0.5", port: 2376 });
  });

  it("defaults tcp:// to port 2375", () => {
    expect(parseDockerHost("tcp://docker.internal")).toEqual({ host: "docker.internal", port: 2375 });
  });

  it("rejects ssh:// with a clear error", () => {
    expect(() => parseDockerHost("ssh://deploy@builder")).toThrow(/ssh:\/\/ works for the docker CLI only/);
  });

  it("rejects an unknown scheme", () => {
    expect(() => parseDockerHost("npipe:////./pipe/docker_engine")).toThrow(/unix:\/\/ or tcp:\/\//);
  });
});
