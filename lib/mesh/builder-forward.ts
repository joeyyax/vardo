// The WireGuard container's DNAT of the builder port to the isolated builder, from the tunnel addresses of peers it runs builds for.
// Live rules only, reconciled each heartbeat and on every link change; without them the port answers nobody.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { isRunningInContainer } from "./env";
import { assertForwardTarget, meshIpFrom, parseForwardRules, wgExec } from "./console-forward";
import { MESH_BUILDER_CONTAINER, MESH_BUILDER_PORT } from "./constants";
import { ownMeshAddress } from "./heartbeat";
import { MESH_SUBNET } from "./traefik-forward";

const log = logger.child("mesh-builder-forward");

/** The builder's address on the mesh Docker network, or null when it isn't running. */
export async function meshBuilderIp(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect", "-f", "{{.State.Running}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", MESH_BUILDER_CONTAINER,
    ], { env: dockerEnv() });
    const [running, ...addresses] = stdout.trim().split(/\s+/);
    return running === "true" ? meshIpFrom(addresses) : null;
  } catch {
    return null;
  }
}

/** Tunnel addresses of direct peers this instance issued builder certificates to. */
export async function builderSources(): Promise<string[]> {
  const rows = await db.query.meshPeers.findMany({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.acceptBuilds, true), isNotNull(meshPeers.builderCert)),
    columns: { internalIp: true },
  });
  return [...new Set(rows.map((r) => ownMeshAddress(r.internalIp)).filter((ip): ip is string => !!ip))].sort();
}

const sourceOf = (line: string) => line.match(/(?:^|\s)-s (\d{1,3}(?:\.\d{1,3}){3})\/32(?:\s|$)/)?.[1] ?? null;

/** iptables argument lists that leave one DNAT rule per source in `sources`, each to `ip`, and none else on the port. */
export function planBuilderDnat(output: string, ip: string | null, sources: string[], port: string = MESH_BUILDER_PORT): string[][] {
  const plan: string[][] = [];
  const kept = new Set<string>();
  for (const rule of parseForwardRules(output, port)) {
    const src = sourceOf(rule.line);
    if (ip && src && rule.ip === ip && sources.includes(src) && !kept.has(src)) {
      kept.add(src);
      continue;
    }
    plan.push(["-t", "nat", "-D", ...rule.line.split(/\s+/).slice(1)]);
  }
  if (!ip) return plan;
  for (const src of sources) {
    assertForwardTarget(src, port);
    if (!kept.has(src)) plan.push(["-t", "nat", "-A", "PREROUTING", "-s", `${src}/32`, "-i", "wg0", "-p", "tcp", "--dport", port, "-j", "DNAT", "--to-destination", `${ip}:${port}`]);
  }
  return plan;
}

/** Masquerade rules for the port that point anywhere but `ip`, as delete argument lists. */
export function staleMasquerades(output: string, ip: string | null, port: string = MESH_BUILDER_PORT): string[][] {
  return output.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("-A POSTROUTING") && l.includes("-j MASQUERADE") && new RegExp(`--dport ${port}(\\s|$)`).test(l) && / -d \d/.test(l) && !(ip && l.includes(` -d ${ip}/32 `)))
    .map((l) => ["-t", "nat", "-D", ...l.split(/\s+/).slice(1)]);
}

export type BuilderForwardCheck =
  | { state: "ok"; target: string | null; sources: string[] }
  | { state: "repaired"; target: string | null; sources: string[]; changed: number }
  | { state: "failed"; reason: string };

/** Points the builder port at the running builder for each accepted peer, and closes it to everyone else. */
export async function reconcileBuilderForward(port: string = MESH_BUILDER_PORT): Promise<BuilderForwardCheck | null> {
  if (!isRunningInContainer()) return null;
  try {
    const ip = await meshBuilderIp();
    if (ip) assertForwardTarget(ip, port);
    const sources = ip ? await builderSources() : [];
    const target = sources.length > 0 ? ip : null;
    const plan = [
      ...planBuilderDnat(await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]), target, sources, port),
      ...staleMasquerades(await wgExec(["iptables", "-t", "nat", "-S", "POSTROUTING"]), target, port),
    ];
    for (const args of plan) await wgExec(["iptables", ...args]);
    if (target) {
      // Replies go back through the tunnel: the builder has no route to it.
      await wgExec(["sh", "-c", `iptables -t nat -C POSTROUTING -s ${MESH_SUBNET} -d ${target}/32 -p tcp --dport ${port} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${MESH_SUBNET} -d ${target}/32 -p tcp --dport ${port} -j MASQUERADE`]);
      await wgExec(["sh", "-c", `iptables -C FORWARD -s ${MESH_SUBNET} -i wg0 -d ${target}/32 -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -A FORWARD -s ${MESH_SUBNET} -i wg0 -d ${target}/32 -p tcp --dport ${port} -j ACCEPT`]);
    }
    if (plan.length === 0) return { state: "ok", target, sources };
    log.info(`Mesh builder forward now admits ${sources.length > 0 ? sources.join(", ") : "no peers"} (${plan.length} rule changes)`);
    return { state: "repaired", target, sources, changed: plan.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Mesh builder forward check failed: ${reason}`);
    return { state: "failed", reason };
  }
}
