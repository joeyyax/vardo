// Two WireGuard-linked containers: A reaches B's Docker through B's mesh SSH endpoint, and nothing else.
// Runs only with VARDO_E2E_MESH_SSH=1 and a local Docker daemon. Creates and removes its own networks and containers.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";

const id = `${process.pid}${Date.now().toString(36)}`.slice(-8);
const names = {
  wan: `e2e-wan-${id}`,
  mesh: `e2e-bmesh-${id}`,
  a: `e2e-a-wg-${id}`,
  b: `e2e-b-wg-${id}`,
  ssh: `e2e-mesh-ssh-${id}`,
  probe: `e2e-probe-${id}`,
  volume: `e2e-mesh-ssh-${id}`,
};
process.env.VARDO_MESH_SSH_CONTAINER = names.ssh;

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: async () => null, invalidateSettingsCache: () => {}, setSystemSetting: async () => {} }));

const enabled = process.env.VARDO_E2E_MESH_SSH === "1";
const WG_IMAGE = "linuxserver/wireguard:1.0.20260223-r0-ls119";
const SSH_IMAGE = "docker:28.5.1-cli";
const WAN = { subnet: "172.31.250.0/24", a: "172.31.250.10", b: "172.31.250.20" };
const MESH = { subnet: "10.88.250.0/24", gateway: "10.88.250.2", ssh: "10.88.250.10" };

const { generateClientKey, meshSshHostKey, syncAuthorizedKeys } = await import("@/lib/mesh/ssh-endpoint");
const { buildWgConfig } = await import("@/lib/mesh/wireguard");
const { knownHostsLine } = await import("@/lib/mesh/build-peers");
const { sshConfig } = await import("@/lib/docker/build-targets");

type Result = { code: number; stdout: string; stderr: string };

function docker(args: string[], input?: string, timeout = 120_000): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin?.end(input ?? "");
  });
}

async function must(args: string[], input?: string): Promise<string> {
  const r = await docker(args, input);
  if (r.code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function waitFor(what: string, check: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const A_PATH = "/e2e/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const onA = (args: string[], env: Record<string, string> = {}) =>
  docker(["exec", ...Object.entries({ PATH: A_PATH, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]), names.a, ...args], "", 60_000);

describe.skipIf(!enabled)("mesh SSH endpoint over WireGuard", () => {
  const dirs: string[] = [];
  let clientPublicKey = "";

  beforeAll(async () => {
    await must(["network", "create", "--subnet", WAN.subnet, names.wan]);
    await must(["network", "create", "--subnet", MESH.subnet, names.mesh]);

    const genkey = () => must(["run", "--rm", "--entrypoint", "wg", WG_IMAGE, "genkey"]);
    const pubkey = (priv: string) => must(["run", "--rm", "-i", "--entrypoint", "wg", WG_IMAGE, "pubkey"], `${priv}\n`);
    const [privA, privB] = [await genkey(), await genkey()];
    const [pubA, pubB] = [await pubkey(privA), await pubkey(privB)];

    const confDir = async (conf: string) => {
      const dir = await mkdtemp(join(tmpdir(), "vardo-e2e-wg-"));
      dirs.push(dir);
      await mkdir(join(dir, "wg_confs"));
      await writeFile(join(dir, "wg_confs", "wg0.conf"), conf);
      return dir;
    };
    // B forwards the SSH port to its endpoint; the console target doesn't exist here.
    const dirB = await confDir(buildWgConfig(privB, 51820, "10.99.0.2", [{ publicKey: pubA, allowedIps: "10.99.0.1/32" }], "10.88.250.3", MESH.ssh));
    const dirA = await confDir(buildWgConfig(privA, 51820, "10.99.0.1", [{ publicKey: pubB, allowedIps: "10.99.0.2/32", endpoint: `${WAN.b}:51820` }], "10.88.251.3"));

    const wg = (name: string, ip: string, dir: string) => [
      "run", "-d", "--name", name, "--cap-add", "NET_ADMIN", "--sysctl", "net.ipv4.conf.all.src_valid_mark=1",
      "--sysctl", "net.ipv4.ip_forward=1", "-e", "PUID=1000", "-e", "PGID=1000",
      "--network", names.wan, "--ip", ip, "-v", `${dir}:/config`, WG_IMAGE,
    ];
    await must(wg(names.b, WAN.b, dirB));
    await must(["network", "connect", "--ip", MESH.gateway, names.mesh, names.b]);
    await must(wg(names.a, WAN.a, dirA));

    // The endpoint runs the compose file's own entrypoint, unescaped as compose would.
    const compose = YAML.parse(await readFile(join(process.cwd(), "docker-compose.yml"), "utf8")) as { configs: Record<string, { content: string }> };
    const scriptDir = await mkdtemp(join(tmpdir(), "vardo-e2e-ssh-"));
    dirs.push(scriptDir);
    await writeFile(join(scriptDir, "entrypoint"), compose.configs.mesh_ssh_entrypoint.content.replaceAll("$$", "$"));
    await must([
      "run", "-d", "--name", names.ssh, "--network", names.mesh, "--ip", MESH.ssh, "--cap-add", "NET_ADMIN",
      "-e", `WIREGUARD_GATEWAY=${MESH.gateway}`, "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${names.volume}:/etc/ssh/vardo`, "-v", `${join(scriptDir, "entrypoint")}:/usr/local/bin/vardo-mesh-ssh:ro`,
      "--entrypoint", "sh", SSH_IMAGE, "/usr/local/bin/vardo-mesh-ssh",
    ]);
    // The compose healthcheck's own command.
    await waitFor("sshd", async () => (await docker(["exec", names.ssh, "sh", "-c", "nc -z 127.0.0.1 22"])).code === 0);
    await waitFor("A's tools", async () => (await docker(["exec", names.a, "apk", "add", "--no-cache", "openssh-client", "docker-cli"])).code === 0);
    await waitFor("the tunnel", async () => (await onA(["ping", "-c", "1", "-W", "1", "10.99.0.2"])).code === 0);

    // A's client key goes into B's authorized_keys the way the console writes it.
    const client = await generateClientKey();
    clientPublicKey = client.publicKey;
    expect(await syncAuthorizedKeys([{ id: "peer-a", internalIp: "10.99.0.1", peerSshKey: client.publicKey }])).toBe("written");
    const hostKey = await meshSshHostKey();
    expect(hostKey).toMatch(/^ssh-ed25519 /);

    const put = (path: string, content: string, mode: string) =>
      must(["exec", "-i", names.a, "sh", "-c", `mkdir -p /e2e/bin && cat > ${path} && chmod ${mode} ${path}`], content);
    await put("/e2e/id", client.privateKey, "600");
    await put("/e2e/known_hosts", `${knownHostsLine("10.99.0.2", 22, hostKey!)}\n`, "600");
    await put("/e2e/config", sshConfig("/e2e"), "600");
    await put("/e2e/bin/ssh", '#!/bin/sh\nexec /usr/bin/ssh -F /e2e/config "$@"\n', "700");
  }, 300_000);

  afterAll(async () => {
    for (const name of [names.probe, names.a, names.b, names.ssh]) await docker(["rm", "-f", name]);
    await docker(["volume", "rm", "-f", names.volume]);
    await docker(["network", "rm", names.wan, names.mesh]);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }, 120_000);

  it("runs docker version against B's daemon through the mesh", async () => {
    const r = await onA(["docker", "version", "--format", "{{.Server.Version}}"], { DOCKER_HOST: "ssh://vardo@10.99.0.2:22" });
    console.log(`[e2e] A -> ssh://vardo@10.99.0.2:22 docker version: ${r.stdout.trim()} ${r.stderr.trim()}`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(await must(["version", "--format", "{{.Server.Version}}"]));
    const ran = await onA(["docker", "run", "--rm", "--pull", "never", "alpine:3", "echo", "ran on B"], { DOCKER_HOST: "ssh://vardo@10.99.0.2:22" });
    console.log(`[e2e] A -> docker run on B: ${JSON.stringify(ran.stdout.trim())} ${ran.stderr.trim()}`);
    expect(ran.stdout.trim()).toBe("ran on B");
  });

  it("never runs the command the client asks for", async () => {
    const r = await onA(["sh", "-c", "timeout 15 ssh vardo@10.99.0.2 'echo SHELL-$((6*7)); id' </dev/null"]);
    console.log(`[e2e] shell attempt: exit ${r.code}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr.trim())}`);
    expect(r.stdout).not.toContain("SHELL-42");
    expect(r.stdout).not.toContain("uid=");
  });

  it("refuses a terminal and port forwarding", async () => {
    const pty = await onA(["sh", "-c", "timeout 15 ssh -tt vardo@10.99.0.2 </dev/null"]);
    console.log(`[e2e] pty attempt: ${JSON.stringify(pty.stderr.trim())}`);
    expect(pty.stderr).toMatch(/PTY allocation request failed/);
    const fwd = await onA(["sh", "-c", "timeout 15 ssh -W 127.0.0.1:22 vardo@10.99.0.2 </dev/null"]);
    console.log(`[e2e] forward attempt: ${JSON.stringify(fwd.stderr.trim())}`);
    expect(fwd.stderr).toMatch(/administratively prohibited|forwarding disabled/i);
  });

  it("refuses the key from anywhere but its peer's tunnel address", async () => {
    const key = await must(["exec", names.a, "cat", "/e2e/id"]);
    const knownHosts = (await must(["exec", names.a, "cat", "/e2e/known_hosts"])).replace("10.99.0.2", MESH.ssh);
    await must(["run", "-d", "--name", names.probe, "--network", names.mesh, "--entrypoint", "sleep", SSH_IMAGE, "300"]);
    await waitFor("probe tools", async () => (await docker(["exec", names.probe, "apk", "add", "--no-cache", "openssh-client"])).code === 0);
    await must(["exec", "-i", names.probe, "sh", "-c", "cat > /id && chmod 600 /id"], `${key}\n`);
    await must(["exec", "-i", names.probe, "sh", "-c", "cat > /kh"], `${knownHosts}\n`);
    const r = await docker(["exec", names.probe, "sh", "-c", `timeout 15 ssh -i /id -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/kh vardo@${MESH.ssh} </dev/null`]);
    console.log(`[e2e] same key from ${MESH.subnet}: ${JSON.stringify(r.stderr.trim())}`);
    expect(r.stderr).toMatch(/Permission denied \(publickey\)/);
  });

  it("stops letting the peer in once its key is removed", async () => {
    expect(await syncAuthorizedKeys([])).toBe("written");
    const login = await onA(["sh", "-c", "timeout 15 ssh vardo@10.99.0.2 </dev/null"]);
    console.log(`[e2e] after unlink, ssh: ${JSON.stringify(login.stderr.trim())}`);
    expect(login.stderr).toMatch(/Permission denied \(publickey\)/);
    // The docker CLI retries, so sshd's per-source penalty may cut it off before the refusal.
    const r = await onA(["docker", "version", "--format", "{{.Server.Version}}"], { DOCKER_HOST: "ssh://vardo@10.99.0.2:22" });
    console.log(`[e2e] after unlink, docker version: exit ${r.code}`);
    expect(r.code).not.toBe(0);
    const logs = (await docker(["logs", names.ssh])).stderr;
    expect(logs).toContain(`Failed publickey for vardo from 10.99.0.1`);
    expect(logs).not.toContain(clientPublicKey);
  });
});
