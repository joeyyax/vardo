// The WireGuard container's DNAT of tunnel traffic on ports 80 and 443 to Traefik, so a linked instance can check this one's sites through the tunnel.
// Installed only while a linked peer is allowed to check this instance. Only mesh addresses match.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { isRunningInContainer } from "./env";
import { assertForwardTarget, parseForwardRules, readConfTarget, wgExec } from "./console-forward";
import { HUB_IP } from "./ip-allocator";

const log = logger.child("mesh-traefik-forward");

export const TRAEFIK_CONTAINER = process.env.VARDO_TRAEFIK_CONTAINER || "vardo-traefik";
const TRAEFIK_NETWORK = process.env.TRAEFIK_DOCKER_NETWORK || "vardo-network";

/** Ports Traefik answers on at the tunnel address. */
export const TRAEFIK_PORTS = ["80", "443"] as const;

/** The mesh subnet; the only source the forward matches. */
export const MESH_SUBNET = `${HUB_IP.split(".").slice(0, 3).join(".")}.0/24`;

/** Off unless VARDO_MESH_TRAEFIK_FORWARD=true. */
export const traefikForwardEnabled = () => process.env.VARDO_MESH_TRAEFIK_FORWARD === "true";

/** True while a linked instance is allowed to check this one. */
export async function peerChecksAllowed(): Promise<boolean> {
  const row = await db.query.meshPeers.findFirst({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.uptimeChecksUs, true)),
    columns: { id: true },
  });
  return !!row;
}

/** Whether the forward should exist now. */
export async function traefikForwardWanted(): Promise<boolean> {
  return traefikForwardEnabled() && (await peerChecksAllowed());
}

/** wg0.conf PostUp/PostDown: DNAT ports 80 and 443 from mesh addresses to Traefik, let them through and masquerade so replies return through the tunnel. */
export function traefikForwardHooks(ip: string): { postUp: string; postDown: string } {
  for (const port of TRAEFIK_PORTS) assertForwardTarget(ip, port);
  const rules = (op: "A" | "D") =>
    TRAEFIK_PORTS.flatMap((port) => [
      `iptables -t nat -${op} PREROUTING -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`,
      `iptables -${op} FORWARD -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j ACCEPT`,
      `iptables -t nat -${op} POSTROUTING -s ${MESH_SUBNET} -d ${ip} -p tcp --dport ${port} -j MASQUERADE`,
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

/** iptables argument lists that leave exactly one source-limited DNAT rule for `port`, pointing at `ip`. */
export function planTraefikDnat(output: string, ip: string, port: string): string[][] {
  const plan: string[][] = [];
  let kept = false;
  for (const rule of parseForwardRules(output, port)) {
    if (!kept && rule.ip === ip && rule.line.includes(`-s ${MESH_SUBNET}`)) {
      kept = true;
      continue;
    }
    plan.push(["-t", "nat", "-D", ...rule.line.split(/\s+/).slice(1)]);
  }
  if (!kept) {
    plan.push(["-t", "nat", "-A", "PREROUTING", "-s", MESH_SUBNET, "-i", "wg0", "-p", "tcp", "--dport", port, "-j", "DNAT", "--to-destination", `${ip}:${port}`]);
  }
  return plan;
}

const ensure = (table: string[], rule: string) =>
  `iptables ${table.join(" ")} -C ${rule} 2>/dev/null || iptables ${table.join(" ")} -A ${rule}`;

export type TraefikForwardCheck =
  | { state: "ok"; target: string }
  | { state: "absent" }
  | { state: "disabled" }
  | { state: "unconfigured" }
  | { state: "repaired"; target: string; changed: string[] }
  | { state: "removed"; changed: string[] }
  | { state: "off" }
  | { state: "failed"; reason: string };

/** Deletes every live rule and wg0.conf hook of the forward. */
async function remove(): Promise<string[]> {
  const changed: string[] = [];
  const nat = await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]);
  for (const port of TRAEFIK_PORTS) {
    for (const rule of parseForwardRules(nat, port)) {
      await wgExec(["iptables", "-t", "nat", "-D", ...rule.line.split(/\s+/).slice(1)]);
      changed.push(`DNAT ${port}`);
    }
    await wgExec(["sh", "-c", `while iptables -D FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -D FORWARD -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j ACCEPT 2>/dev/null; do :; done`]);
  }
  const post = await wgExec(["iptables", "-t", "nat", "-S", "POSTROUTING"]);
  for (const line of post.split("\n")) {
    const l = line.trim();
    if (l.startsWith("-A POSTROUTING") && l.includes("-j MASQUERADE") && TRAEFIK_PORTS.some((p) => l.includes(`--dport ${p}`)) && / -d \d/.test(l)) {
      await wgExec(["iptables", "-t", "nat", "-D", ...l.split(/\s+/).slice(1)]);
      changed.push("masquerade");
    }
  }
  const conf = await readConfTarget("443");
  if (conf.exists && conf.ip !== null) {
    const { rebuildAndSync } = await import("./wireguard");
    await rebuildAndSync();
    changed.push("wg0.conf hooks");
  }
  return changed;
}

/** Points the live rules and wg0.conf at the running Traefik while a peer may check this instance, and removes them when none may. */
export async function reconcileTraefikForward(wanted?: boolean): Promise<TraefikForwardCheck | null> {
  if (!isRunningInContainer()) return null;
  try {
    if (!traefikForwardEnabled()) return { state: "disabled" };
    if (!(wanted ?? (await peerChecksAllowed()))) {
      const changed = await remove();
      if (changed.length > 0) log.info(`Mesh Traefik forward removed (${changed.join(", ")})`);
      return changed.length > 0 ? { state: "removed", changed } : { state: "off" };
    }
    const ip = await traefikIp();
    if (!ip) return { state: "absent" };
    assertForwardTarget(ip, "443");
    const conf = await readConfTarget("443");
    if (!conf.exists) return { state: "unconfigured" };
    const changed: string[] = [];
    if (conf.ip !== ip) {
      const { rebuildAndSync } = await import("./wireguard");
      await rebuildAndSync();
      changed.push("wg0.conf hooks");
    }
    const current = await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]);
    for (const port of TRAEFIK_PORTS) {
      const plan = planTraefikDnat(current, ip, port);
      for (const args of plan) await wgExec(["iptables", ...args]);
      if (plan.length > 0) changed.push(`DNAT ${port}`);
      await wgExec(["sh", "-c", ensure([], `FORWARD -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j ACCEPT`)]);
      await wgExec(["sh", "-c", ensure(["-t", "nat"], `POSTROUTING -s ${MESH_SUBNET} -d ${ip} -p tcp --dport ${port} -j MASQUERADE`)]);
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
