// The WireGuard container's DNAT of tunnel traffic on ports 80 and 443 to Traefik, so a linked instance can check this one's sites through the tunnel.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { isRunningInContainer } from "./env";
import { assertForwardTarget, planForward, readConfTarget, WG_CONF, wgExec } from "./console-forward";

const log = logger.child("mesh-traefik-forward");

export const TRAEFIK_CONTAINER = process.env.VARDO_TRAEFIK_CONTAINER || "vardo-traefik";
const TRAEFIK_NETWORK = process.env.TRAEFIK_DOCKER_NETWORK || "vardo-network";

/** Ports Traefik answers on at the tunnel address. */
export const TRAEFIK_PORTS = ["80", "443"] as const;

/** Off with VARDO_MESH_TRAEFIK_FORWARD=false. */
export const traefikForwardEnabled = () => process.env.VARDO_MESH_TRAEFIK_FORWARD !== "false";

/** wg0.conf PostUp/PostDown: DNAT ports 80 and 443 to Traefik, let them through and masquerade so Traefik's replies return through the tunnel. */
export function traefikForwardHooks(ip: string): { postUp: string; postDown: string } {
  for (const port of TRAEFIK_PORTS) assertForwardTarget(ip, port);
  const rules = (op: "A" | "D") =>
    TRAEFIK_PORTS.flatMap((port) => [
      `iptables -t nat -${op} PREROUTING -i wg0 -p tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`,
      `iptables -${op} FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`,
      `iptables -t nat -${op} POSTROUTING -d ${ip} -p tcp --dport ${port} -j MASQUERADE`,
    ]).join("; ");
  return { postUp: rules("A"), postDown: rules("D") };
}

/** Traefik's address on the Docker network it shares with the WireGuard container, or null when it isn't running. */
export async function traefikIp(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", `{{.State.Running}} {{with index .NetworkSettings.Networks "${TRAEFIK_NETWORK}"}}{{.IPAddress}}{{end}}`, TRAEFIK_CONTAINER],
      { env: dockerEnv() },
    );
    const [running, ip] = stdout.trim().split(/\s+/);
    return running === "true" && ip ? ip : null;
  } catch {
    return null;
  }
}

export type TraefikForwardCheck =
  | { state: "ok"; target: string }
  | { state: "absent" }
  | { state: "disabled" }
  | { state: "unconfigured" }
  | { state: "repaired"; target: string; changed: string[] }
  | { state: "failed"; reason: string };

/** Points the live rules and wg0.conf at the running Traefik. */
export async function reconcileTraefikForward(): Promise<TraefikForwardCheck | null> {
  if (!isRunningInContainer()) return null;
  if (!traefikForwardEnabled()) return { state: "disabled" };
  const ip = await traefikIp();
  if (!ip) return { state: "absent" };
  try {
    assertForwardTarget(ip, "443");
    const conf = await readConfTarget("443");
    if (!conf.exists) return { state: "unconfigured" };
    const changed: string[] = [];
    if (conf.ip === null) {
      const { rebuildAndSync } = await import("./wireguard");
      await rebuildAndSync();
      changed.push("wg0.conf hooks");
    } else if (conf.ip !== ip) {
      for (const port of TRAEFIK_PORTS) {
        await wgExec(["sh", "-c", `sed -i -E 's/--to-destination [0-9.]+:${port}( |;|$)/--to-destination ${ip}:${port}\\1/g; s/-d [0-9.]+ -p tcp --dport ${port} -j MASQUERADE/-d ${ip} -p tcp --dport ${port} -j MASQUERADE/g' ${WG_CONF}`]);
      }
      changed.push(`wg0.conf ${conf.ip} -> ${ip}`);
    }
    const current = await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]);
    for (const port of TRAEFIK_PORTS) {
      const plan = planForward(current, ip, port);
      for (const args of plan) await wgExec(["iptables", ...args]);
      if (plan.length > 0) changed.push(`DNAT ${port}`);
      await wgExec(["sh", "-c", `iptables -C FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -A FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`]);
      await wgExec([
        "sh",
        "-c",
        `iptables -t nat -C POSTROUTING -d ${ip} -p tcp --dport ${port} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -d ${ip} -p tcp --dport ${port} -j MASQUERADE`,
      ]);
    }
    if (changed.length === 0) return { state: "ok", target: ip };
    log.info(`Mesh Traefik forward now points at ${ip} (${changed.join(", ")})`);
    return { state: "repaired", target: ip, changed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Mesh Traefik forward check failed: ${reason}`);
    return { state: "failed", reason };
  }
}
