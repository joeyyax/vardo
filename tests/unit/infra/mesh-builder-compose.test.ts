// The mesh builder in Vardo's own compose: rootless, capped, mesh-only, with no Docker socket or host paths.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

type Service = {
  image?: string;
  ports?: unknown[];
  networks?: string[] | Record<string, unknown>;
  profiles?: string[];
  configs?: { source: string; target: string }[];
  entrypoint?: string[];
  "x-vardo-shared"?: boolean;
  volumes?: string[];
  privileged?: boolean;
  user?: string;
  cap_add?: string[];
  devices?: unknown[];
  security_opt?: string[];
  mem_limit?: string;
  cpus?: string | number;
  pids_limit?: number;
  network_mode?: string;
  pid?: string;
};
const compose = YAML.parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")) as {
  services: Record<string, Service>;
  configs: Record<string, { content: string }>;
  volumes: Record<string, unknown>;
};
const svc = compose.services["mesh-builder"];
const script = compose.configs.mesh_builder_entrypoint.content;

describe("mesh-builder service", () => {
  it("is a shared production service on the rootless image of vardo-buildkit's version", () => {
    expect(svc["x-vardo-shared"]).toBe(true);
    expect(svc.profiles).toEqual(compose.services["mesh-ssh"].profiles);
    expect(svc.image).toBe(`${compose.services.buildkit.image}-rootless`);
  });

  it("has no Docker socket, host paths or devices, only its cache volume", () => {
    expect(svc.volumes).toEqual(["mesh_builder:/home/user/.local/share/buildkit"]);
    expect(Object.keys(compose.volumes)).toContain("mesh_builder");
    expect(JSON.stringify(svc)).not.toMatch(/docker\.sock/);
    expect(svc.devices).toBeUndefined();
  });

  it("runs unprivileged as the image's user, with no added capabilities or host namespaces", () => {
    expect(svc.privileged).toBeUndefined();
    expect(svc.user).toBeUndefined();
    expect(svc.cap_add).toBeUndefined();
    expect(svc.network_mode).toBeUndefined();
    expect(svc.pid).toBeUndefined();
    expect(svc.security_opt).toEqual(["seccomp=unconfined", "apparmor=unconfined", "systempaths=unconfined"]);
  });

  it("caps memory, CPU and processes", () => {
    expect(svc.mem_limit).toBe("${VARDO_MESH_BUILDER_MEM:-4g}");
    expect(String(svc.cpus)).toBe("${VARDO_MESH_BUILDER_CPUS:-2}");
    expect(svc.pids_limit).toBeGreaterThan(0);
  });

  it("publishes no port and joins only the mesh network", () => {
    expect(svc.ports).toBeUndefined();
    expect(svc.networks).toEqual(["mesh"]);
  });

  it("serves BuildKit only over mutual TLS, with the process sandbox on", () => {
    expect(svc.configs).toContainEqual({ source: "mesh_builder_entrypoint", target: "/usr/local/bin/vardo-mesh-builder" });
    expect(svc.entrypoint).toEqual(["sh", "/usr/local/bin/vardo-mesh-builder"]);
    const exec = script.split("\n").find((l) => l.startsWith("exec "))!;
    expect(exec).toMatch(/^exec rootlesskit buildkitd /);
    for (const flag of ["--addr \"tcp://0.0.0.0:$$port\"", "--tlscacert", "--tlscert", "--tlskey"]) expect(exec).toContain(flag);
    expect(exec).not.toContain("unix://");
    expect(script).not.toContain("--oci-worker-no-process-sandbox");
  });
});
