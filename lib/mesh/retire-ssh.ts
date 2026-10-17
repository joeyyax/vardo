// Removes what mesh SSH left on an instance that ran it: the WireGuard forward, the vardo-mesh-ssh container and its volume.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { isRunningInContainer } from "./env";
import { parseForwardRules, WG_CONF, wgExec } from "./console-forward";

const log = logger.child("mesh-ssh-retire");

const CONTAINER = "vardo-mesh-ssh";
const SERVICE = "mesh-ssh";
const KEY_DIR = "/etc/ssh/vardo";
const PORT = process.env.VARDO_MESH_SSH_PORT || "22";

const globalForRetire = globalThis as unknown as { __vardo_mesh_ssh_retired?: boolean };

/** Test hook. */
export function resetRetireMeshSsh(): void {
  globalForRetire.__vardo_mesh_ssh_retired = undefined;
}

/** iptables argument lists that delete the SSH DNAT rules in `iptables -t nat -S PREROUTING` output. */
export function planSshForwardRemoval(output: string, port: string = PORT): string[][] {
  return parseForwardRules(output, port).map((rule) => ["-t", "nat", "-D", ...rule.line.split(/\s+/).slice(1)]);
}

async function removeForward(): Promise<number> {
  let removed = 0;
  for (const args of planSshForwardRemoval(await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]))) {
    await wgExec(["iptables", ...args]);
    removed++;
  }
  const accept = `FORWARD -i wg0 -p tcp --dport ${PORT} -j ACCEPT`;
  const dropped = await wgExec(["sh", "-c", `n=0; while iptables -C ${accept} 2>/dev/null; do iptables -D ${accept}; n=$((n+1)); done; echo $n`]);
  removed += Number(dropped.trim()) || 0;
  await wgExec(["sh", "-c", `[ ! -f ${WG_CONF} ] || sed -i -E '/^Post(Up|Down) = iptables -t nat -[AD] PREROUTING -i wg0 -p tcp --dport ${PORT} -j DNAT /d' ${WG_CONF}`]);
  return removed;
}

/** The container's compose service and key volume, or null when it doesn't exist. */
async function inspectContainer(): Promise<{ service: string; volume: string } | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect", "-f", `{{index .Config.Labels "com.docker.compose.service"}}|{{range .Mounts}}{{if eq .Destination "${KEY_DIR}"}}{{.Name}}{{end}}{{end}}`, CONTAINER,
    ], { env: dockerEnv(), timeout: 10_000 });
    const [service = "", volume = ""] = stdout.trim().split("|");
    return { service, volume };
  } catch (err) {
    if (/No such (object|container)/i.test(String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? err))) return null;
    throw err;
  }
}

/** Removes mesh SSH's leftovers once per process; a failed pass tries again on the next call. */
export async function retireMeshSsh(): Promise<void> {
  if (globalForRetire.__vardo_mesh_ssh_retired) return;
  try {
    const rules = isRunningInContainer() ? await removeForward().catch((err) => {
      if (/No such container|is not running/i.test(String(err?.stderr ?? err?.message ?? err))) return 0;
      throw err;
    }) : 0;
    const container = await inspectContainer();
    if (container?.service === SERVICE) {
      await execFileAsync("docker", ["rm", "-f", CONTAINER], { env: dockerEnv(), timeout: 30_000 });
      if (container.volume) {
        await execFileAsync("docker", ["volume", "rm", container.volume], { env: dockerEnv(), timeout: 30_000 })
          .catch((err) => log.warn(`Couldn't remove the ${container.volume} volume: ${err instanceof Error ? err.message : err}`));
      }
    }
    if (rules > 0 || container?.service === SERVICE) log.info(`Removed mesh SSH (${rules} forward rules${container?.service === SERVICE ? `, ${CONTAINER}` : ""})`);
    globalForRetire.__vardo_mesh_ssh_retired = true;
  } catch (err) {
    log.debug(`Couldn't remove mesh SSH yet: ${err instanceof Error ? err.message : err}`);
  }
}
