// The mesh SSH endpoint in Vardo's own compose: shared, reachable only through the mesh, Docker only.

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
  healthcheck?: { test: string[] };
};
const compose = YAML.parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")) as {
  services: Record<string, Service>;
  configs: Record<string, { content: string }>;
};
const svc = compose.services["mesh-ssh"];
const script = compose.configs.mesh_ssh_entrypoint.content;

describe("mesh-ssh service", () => {
  it("is a shared production service on the watchdog's pinned image", () => {
    expect(svc["x-vardo-shared"]).toBe(true);
    expect(svc.profiles).toEqual(["production"]);
    expect(svc.image).toBe(compose.services.watchdog.image);
  });

  it("publishes no port and joins only the mesh network", () => {
    expect(svc.ports).toBeUndefined();
    expect(svc.networks).toEqual(["mesh"]);
  });

  it("runs its entrypoint from inline content, so a slot change doesn't recreate it", () => {
    expect(svc.configs).toEqual([{ source: "mesh_ssh_entrypoint", target: "/usr/local/bin/vardo-mesh-ssh" }]);
    expect(svc.entrypoint).toEqual(["sh", "/usr/local/bin/vardo-mesh-ssh"]);
    expect(svc.volumes?.some((v) => v.startsWith("./"))).toBe(false);
  });

  it("checks health without connecting to sshd", () => {
    expect(svc.healthcheck?.test.join(" ")).toMatch(/netstat -ltn/);
    expect(svc.healthcheck?.test.join(" ")).not.toMatch(/\bnc\b/);
  });

  it("forces dial-stdio and allows nothing else", () => {
    for (const line of [
      "ForceCommand docker system dial-stdio",
      "AllowUsers vardo",
      "AuthenticationMethods publickey",
      "PasswordAuthentication no",
      "PermitRootLogin no",
      "PermitTTY no",
      "DisableForwarding yes",
      "AllowTcpForwarding no",
      "PermitUserRC no",
      "PermitUserEnvironment no",
    ]) {
      expect(script.split("\n")).toContain(line);
    }
    expect(script).not.toMatch(/^Subsystem/m);
  });
});
