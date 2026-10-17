// The WireGuard container's DNAT of tunnel traffic on the mesh SSH port to the mesh SSH endpoint.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { isRunningInContainer } from "./env";
import { assertForwardTarget, meshIpFrom, planForward, readConfTarget, WG_CONF, wgExec } from "./console-forward";
import { MESH_SSH_CONTAINER, MESH_SSH_PORT } from "./constants";

const log = logger.child("mesh-ssh-forward");

/** wg0.conf PostUp/PostDown for the SSH endpoint: DNAT the port to `ip` and let it through. */
export function sshForwardHooks(ip: string, port: string = MESH_SSH_PORT): { postUp: string; postDown: string } {
  assertForwardTarget(ip, port);
  const rules = (op: "A" | "D") => [
    `iptables -t nat -${op} PREROUTING -i wg0 -p tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`,
    `iptables -${op} FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`,
  ].join("; ");
  return { postUp: rules("A"), postDown: rules("D") };
}

/** The SSH endpoint's address on the mesh Docker network, or null when it isn't running. */
export async function meshSshIp(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect", "-f", "{{.State.Running}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", MESH_SSH_CONTAINER,
    ], { env: dockerEnv() });
    const [running, ...addresses] = stdout.trim().split(/\s+/);
    return running === "true" ? meshIpFrom(addresses) : null;
  } catch {
    return null;
  }
}

export type SshForwardCheck =
  | { state: "ok"; target: string }
  | { state: "absent" }
  | { state: "unconfigured" }
  | { state: "repaired"; target: string; changed: string[] }
  | { state: "failed"; reason: string };

/** Points the live rule and wg0.conf at the running SSH endpoint. */
export async function reconcileSshForward(port: string = MESH_SSH_PORT): Promise<SshForwardCheck | null> {
  if (!isRunningInContainer()) return null;
  const ip = await meshSshIp();
  if (!ip) return { state: "absent" };
  try {
    assertForwardTarget(ip, port);
    const conf = await readConfTarget(port);
    if (!conf.exists) return { state: "unconfigured" };
    const changed: string[] = [];
    if (conf.ip === null) {
      const { rebuildAndSync } = await import("./wireguard");
      await rebuildAndSync();
      changed.push("wg0.conf hooks");
    } else if (conf.ip !== ip) {
      await wgExec(["sh", "-c", `sed -i -E 's/--to-destination [0-9.]+:${port}( |;|$)/--to-destination ${ip}:${port}\\1/g' ${WG_CONF}`]);
      changed.push(`wg0.conf ${conf.ip} -> ${ip}`);
    }
    const plan = planForward(await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]), ip, port);
    for (const args of plan) await wgExec(["iptables", ...args]);
    if (plan.length > 0) changed.push("DNAT rule");
    const accept = `-A FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`;
    await wgExec(["sh", "-c", `iptables -C ${accept.slice(3)} 2>/dev/null || iptables ${accept}`]);
    if (changed.length === 0) return { state: "ok", target: ip };
    log.info(`Mesh SSH forward now points at ${ip}:${port} (${changed.join(", ")})`);
    return { state: "repaired", target: ip, changed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Mesh SSH forward check failed: ${reason}`);
    return { state: "failed", reason };
  }
}
