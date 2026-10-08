// Every #886 escape, as `docker compose config` resolves it, is refused for an untrusted org.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { appRootDir } from "@/lib/docker/compose-root";
import {
  assertComposeWithinApp,
  composePolicyErrors,
  type ComposePolicy,
} from "@/lib/docker/compose-policy";
import { parseCompose } from "@/lib/docker/compose-parse";
import { dockerEnv } from "@/lib/docker/docker-env";

const APP_DIR = "/opt/vardo/apps/blog/production";
const SLOT = `${APP_DIR}/blue`;
const REPO = "/opt/vardo/apps/blog/repo";

const untrusted: ComposePolicy = {
  trusted: false,
  projectName: "blog-production-blue",
  ownDirs: [APP_DIR, REPO],
  ownPrefix: "blog-production_",
  allowBindMounts: false,
  allowDockerSocket: false,
  realpath: (p) => p,
};
const withBinds: ComposePolicy = { ...untrusted, allowBindMounts: true, allowDockerSocket: true };

type Obj = Record<string, unknown>;

/** A resolved model shaped like Vardo's bare plus overlay files. */
function config(web: Obj = {}, top: Obj = {}): Obj {
  return {
    name: "blog-production-blue",
    services: {
      web: {
        image: "nginx",
        labels: { "traefik.enable": "true" },
        networks: { default: null, "vardo-network": null },
        volumes: [{ type: "volume", source: "data", target: "/data", volume: {} }],
        ...web,
      },
    },
    networks: {
      default: { name: "blog-production-blue_default", ipam: {} },
      "vardo-network": { name: "vardo-network", external: true },
      ...(top.networks as Obj),
    },
    volumes: {
      data: { name: "blog-production_data", external: true },
      ...(top.volumes as Obj),
    },
    ...(top.configs ? { configs: top.configs } : {}),
    ...(top.secrets ? { secrets: top.secrets } : {}),
  };
}

const bind = (source: string, extra: Obj = {}) => ({
  volumes: [{ type: "bind", source, target: "/host", bind: {}, ...extra }],
});

describe("composePolicyErrors", () => {
  it("passes a plain routed app with an externalized volume", () => {
    expect(composePolicyErrors(config(), untrusted)).toEqual([]);
  });

  describe("Traefik's API (#889)", () => {
    const labels = (extra: Obj) => ({ labels: { "traefik.enable": "true", ...extra } });

    it("refuses routing a public host to api@internal", () => {
      const cfg = config(labels({ "traefik.http.routers.x.rule": "Host(`a.example.com`)", "traefik.http.routers.x.service": "api@internal" }));
      expect(composePolicyErrors(cfg, untrusted)).toEqual(['Service "web" routes to Traefik\'s internal "api@internal"']);
    });

    it("refuses a router on the internal entrypoint", () => {
      const cfg = config(labels({ "traefik.http.routers.x.entrypoints": "websecure, traefik" }));
      expect(composePolicyErrors(cfg, untrusted)).toEqual(['Service "web" routes on Traefik\'s internal entrypoint']);
    });

    it("refuses a routed service that would answer to Vardo's names on vardo-network", () => {
      const cfg = config({ container_name: "vardo-traefik" });
      expect(composePolicyErrors(cfg, untrusted)).toEqual([
        'Service "web" answers to "vardo-traefik" on vardo-network, a name Vardo\'s own services use',
      ]);
      expect(composePolicyErrors(config({ hostname: "loki" }), untrusted)).toHaveLength(1);
    });

    it("passes the file-provider transport Vardo writes", () => {
      const cfg = config(labels({ "traefik.http.services.web.loadbalancer.serversTransport": "blog-insecure@file" }));
      expect(composePolicyErrors(cfg, untrusted)).toEqual([]);
    });
  });

  it("refuses nothing for a trusted org", () => {
    const everything = config({ privileged: true, ...bind("/") }, {
      networks: { internal: { name: "vardo_internal", external: true } },
    });
    expect(composePolicyErrors(everything, { ...untrusted, trusted: true })).toEqual([]);
  });

  describe("bind sources the old string check missed", () => {
    it("refuses `.`, which resolves to the slot", () => {
      expect(composePolicyErrors(config(bind(SLOT)), untrusted)).toEqual([
        `Service "web" mounts host path "${SLOT}", and bind mounts are off for this project`,
      ]);
    });

    it("refuses `~/`, which resolves to the console's home, even with bind mounts on", () => {
      expect(composePolicyErrors(config(bind("/root")), untrusted)).toHaveLength(1);
      expect(composePolicyErrors(config(bind("/root")), withBinds)).toEqual([
        'Service "web" mounts host path "/root", and nothing under /root can be mounted',
      ]);
    });

    it("refuses `${VAR}` set to /, even with bind mounts on", () => {
      expect(composePolicyErrors(config(bind("/")), untrusted)).toHaveLength(1);
      expect(composePolicyErrors(config(bind("/")), withBinds)[0]).toMatch(/host path "\/", which contains/);
    });
  });

  it("refuses a top-level volume that binds the host through driver_opts", () => {
    const vol = { evil: { name: "blog-production-blue_evil", driver_opts: { type: "none", o: "bind", device: "/" } } };
    const cfg = config({}, { volumes: vol });
    expect(composePolicyErrors(cfg, untrusted)).toEqual([
      'Volume "evil" binds host path "/", and bind mounts are off for this project',
    ]);
    expect(composePolicyErrors(cfg, withBinds)).toHaveLength(1);
  });

  it("refuses configs and secrets read from host files", () => {
    const cfg = config(
      { configs: [{ source: "cfg" }], secrets: [{ source: "sec", target: "/run/secrets/sec" }] },
      {
        configs: { cfg: { name: "blog-production-blue_cfg", file: "/etc/passwd" } },
        secrets: { sec: { name: "blog-production-blue_sec", file: "/opt/vardo/.env" } },
      },
    );
    expect(composePolicyErrors(cfg, untrusted)).toHaveLength(2);
    expect(composePolicyErrors(cfg, withBinds)).toEqual([
      'Config "cfg" reads host path "/etc/passwd", and nothing under /etc can be mounted',
      'Secret "sec" reads host path "/opt/vardo/.env", and nothing under /opt/vardo can be mounted',
    ]);
  });

  it("refuses env_file outside the app's directory, whatever the flags", () => {
    const cfg = config({ env_file: [{ path: "/opt/vardo/.env" }] });
    const refusal = 'Service "web" reads env_file "/opt/vardo/.env", which is outside the app\'s directory';
    expect(composePolicyErrors(cfg, untrusted)).toEqual([refusal]);
    expect(composePolicyErrors(cfg, withBinds)).toEqual([refusal]);
    expect(composePolicyErrors(config({ env_file: [{ path: `${REPO}/.env.example` }] }), untrusted)).toEqual([]);
  });

  it("refuses a build context of /", () => {
    const cfg = config({ build: { context: "/", dockerfile: "Dockerfile", additional_contexts: { x: "/etc" } } });
    expect(composePolicyErrors(cfg, withBinds)).toEqual([
      'Service "web" builds from "/", which is outside the app\'s directory',
      'Service "web" adds build context "x" from "/etc", which is outside the app\'s directory',
    ]);
    expect(composePolicyErrors(config({ build: { context: REPO, dockerfile: "Dockerfile" } }), untrusted)).toEqual([]);
  });

  describe("Vardo's networks", () => {
    it("refuses joining vardo_internal", () => {
      const cfg = config(
        { networks: { default: null, "vardo-network": null, internal: null } },
        { networks: { internal: { name: "vardo_internal", external: true } } },
      );
      expect(composePolicyErrors(cfg, withBinds)).toEqual([
        'Network "internal" joins "vardo_internal", which isn\'t this app\'s',
      ]);
    });

    it("refuses vardo_internal named through network_mode, as parseCompose rewrites it", () => {
      const parsed = parseCompose("services:\n  web:\n    image: nginx\n    network_mode: vardo_internal\n");
      expect(parsed.networks).toEqual({ vardo_internal: { external: true } });
      const cfg = config({}, { networks: { vardo_internal: { name: "vardo_internal", external: true } } });
      expect(composePolicyErrors(cfg, untrusted)).toHaveLength(1);
    });

    it("refuses a non-external network named after Vardo's", () => {
      const cfg = config({}, { networks: { internal: { name: "vardo_internal" } } });
      expect(composePolicyErrors(cfg, untrusted)).toEqual(['Network "internal" sets its own name "vardo_internal"']);
    });

    it("refuses vardo-network on a service Vardo doesn't route", () => {
      const cfg = config({ labels: {} });
      expect(composePolicyErrors(cfg, untrusted)).toEqual([
        'Service "web" joins vardo-network without being routed by Vardo',
      ]);
    });

    it("refuses an external volume outside the app's prefix, such as a top-level `name:` steering Vardo's own", () => {
      const cfg = config({}, { volumes: { data: { name: "vardo_postgres-data", external: true } } });
      expect(composePolicyErrors(cfg, untrusted)).toHaveLength(1);
    });
  });

  it("refuses host namespaces and privileges", () => {
    const cfg = config({ pid: "host", network_mode: "host", cap_add: ["SYS_ADMIN"], privileged: true, networks: undefined });
    expect(composePolicyErrors(cfg, withBinds)).toEqual([
      'Service "web" sets "pid"',
      'Service "web" sets "cap_add"',
      'Service "web" is privileged',
      'Service "web" uses network_mode "host"',
    ]);
  });

  describe("project flags", () => {
    it("bind mounts allow host paths outside the deny list", () => {
      expect(composePolicyErrors(config(bind("/mnt/media")), untrusted)).toHaveLength(1);
      expect(composePolicyErrors(config(bind("/mnt/media")), { ...untrusted, allowBindMounts: true })).toEqual([]);
    });

    it("the Docker socket needs its own flag", () => {
      const cfg = config(bind("/var/run/docker.sock"));
      expect(composePolicyErrors(cfg, { ...untrusted, allowBindMounts: true })).toEqual([
        'Service "web" mounts the Docker socket, and the Docker socket is off for this project',
      ]);
      expect(composePolicyErrors(cfg, { ...untrusted, allowDockerSocket: true })).toEqual([]);
    });

    it("neither flag allows a directory holding the socket", () => {
      expect(composePolicyErrors(config(bind("/var/run")), withBinds)).toEqual([
        'Service "web" mounts host path "/var/run", and nothing under /var/run can be mounted',
      ]);
    });

    it("bind mounts allow /etc/localtime read-only", () => {
      expect(composePolicyErrors(config(bind("/etc/localtime", { read_only: true })), withBinds)).toEqual([]);
      expect(composePolicyErrors(config(bind("/etc/localtime")), withBinds)).toHaveLength(1);
    });
  });
});

describe("symlinks out of the app", () => {
  let dir: string;
  let appDir: string;
  let repoDir: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vardo-policy-")));
    appDir = join(dir, "apps/blog/production");
    repoDir = join(dir, "apps/blog/repo");
    await mkdir(join(appDir, "blue"), { recursive: true });
    await mkdir(join(repoDir, "web"), { recursive: true });
    await writeFile(join(dir, "console.env"), "SECRET=x\n");
    await symlink(join(dir, "console.env"), join(repoDir, "leak.env"));
    await symlink("/", join(repoDir, "root"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses an env_file that links outside the app", () => {
    const policy = { ...untrusted, ownDirs: [appDir, repoDir], realpath: undefined };
    expect(composePolicyErrors(config({ env_file: [{ path: join(repoDir, "leak.env") }] }), policy)).toHaveLength(1);
  });

  it("refuses a rootDirectory with `..` or through a link", () => {
    expect(appRootDir(repoDir, "web")).toBe(join(repoDir, "web"));
    expect(appRootDir(repoDir, "/web")).toBe(join(repoDir, "web"));
    expect(() => appRootDir(repoDir, "..")).toThrow(/outside the repository/);
    expect(() => appRootDir(repoDir, "web/../../production")).toThrow(/outside the repository/);
    expect(() => appRootDir(repoDir, "root/etc")).toThrow(/outside the repository/);
  });
});

function hasCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { env: dockerEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasCompose())("real docker compose config", () => {
  let dir: string;
  let appDir: string;
  let slotDir: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vardo-policy-real-")));
    appDir = join(dir, "blog/production");
    slotDir = join(appDir, "blue");
    await mkdir(slotDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function check(bare: string, env = ""): Promise<void> {
    await writeFile(join(slotDir, "docker-compose.yml"), bare);
    await writeFile(
      join(slotDir, "docker-compose.override.yml"),
      [
        "services:",
        "  web:",
        "    labels:",
        '      traefik.enable: "true"',
        "    networks: [vardo-network]",
        "networks:",
        "  vardo-network:",
        "    external: true",
        "",
      ].join("\n"),
    );
    await writeFile(join(slotDir, ".env"), env);
    await assertComposeWithinApp({
      slotDir,
      appDir,
      repoDir: null,
      newProjectName: "blog-production-blue",
      stableVolumePrefix: "blog-production",
      composeFileArgs: ["-f", join(slotDir, "docker-compose.yml"), "-f", join(slotDir, "docker-compose.override.yml")],
      orgTrusted: false,
      projectAllowBindMounts: false,
      projectAllowDockerSocket: false,
    });
  }

  it("passes Vardo's own output for a plain app", async () => {
    const bare = [
      "services:",
      "  web:",
      "    image: nginx",
      "    volumes: [data:/data]",
      "    tmpfs: [/tmp]",
      "volumes:",
      "  data:",
      "    external: true",
      "    name: blog-production_data",
      "",
    ].join("\n");
    await expect(check(bare)).resolves.toBeUndefined();
  });

  it("refuses ${VAR} once interpolated, and clears the slot's files", async () => {
    const bare = "services:\n  web:\n    image: nginx\n    volumes: ['${HOSTDIR}:/host']\n";
    await expect(check(bare, "HOSTDIR=/\n")).rejects.toThrow('mounts host path "/"');
    expect(execFileSync("ls", ["-A", slotDir], { encoding: "utf-8" }).trim()).toBe("");
  });
});

describe("assertComposeWithinApp", () => {
  it("doesn't resolve a trusted org's compose at all", async () => {
    await expect(
      assertComposeWithinApp({
        slotDir: "/nonexistent",
        appDir: "/nonexistent",
        repoDir: null,
        newProjectName: "x",
        stableVolumePrefix: "x",
        composeFileArgs: ["-f", "/nonexistent/docker-compose.yml"],
        orgTrusted: true,
        projectAllowBindMounts: false,
        projectAllowDockerSocket: false,
      }),
    ).resolves.toBeUndefined();
  });
});
