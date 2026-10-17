// Removes what the retired Traefik forward left in the WireGuard container: the DNAT of tunnel ports 80 and 443 to Traefik and its wg0.conf hooks.

import { logger } from "@/lib/logger";
import { MESH_SUBNET } from "./constants";
import { isRunningInContainer } from "./env";
import { parseForwardRules, WG_CONF, wgExec } from "./console-forward";

const log = logger.child("mesh-traefik-retire");

const PORTS = ["80", "443"] as const;

const globalForRetire = globalThis as unknown as { __vardo_traefik_forward_retired?: boolean };

/** Test hook. */
export function resetRetireTraefikForward(): void {
  globalForRetire.__vardo_traefik_forward_retired = undefined;
}

async function removeForward(): Promise<number> {
  let removed = 0;
  const nat = await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]);
  for (const port of PORTS) {
    for (const rule of parseForwardRules(nat, port)) {
      await wgExec(["iptables", "-t", "nat", "-D", ...rule.line.split(/\s+/).slice(1)]);
      removed++;
    }
    const accept = [`FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`, `FORWARD -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j ACCEPT`];
    const loops = accept.map((rule) => `while iptables -C ${rule} 2>/dev/null; do iptables -D ${rule}; n=$((n+1)); done`).join("; ");
    removed += Number((await wgExec(["sh", "-c", `n=0; ${loops}; echo $n`])).trim()) || 0;
  }
  for (const line of (await wgExec(["iptables", "-t", "nat", "-S", "POSTROUTING"])).split("\n")) {
    const l = line.trim();
    if (l.startsWith("-A POSTROUTING") && l.includes("-j MASQUERADE") && PORTS.some((p) => l.includes(`--dport ${p} `)) && / -d \d/.test(l)) {
      await wgExec(["iptables", "-t", "nat", "-D", ...l.split(/\s+/).slice(1)]);
      removed++;
    }
  }
  await wgExec(["sh", "-c", `[ ! -f ${WG_CONF} ] || sed -i -E '/^Post(Up|Down) = .*--dport (80|443) -j DNAT /d' ${WG_CONF}`]);
  return removed;
}

/** Removes the Traefik forward's leftovers once per process; a failed pass tries again on the next call. */
export async function retireTraefikForward(): Promise<void> {
  if (globalForRetire.__vardo_traefik_forward_retired || !isRunningInContainer()) return;
  try {
    const rules = await removeForward().catch((err) => {
      if (/No such container|is not running/i.test(String(err?.stderr ?? err?.message ?? err))) return 0;
      throw err;
    });
    if (rules > 0) log.info(`Removed the mesh Traefik forward (${rules} rules)`);
    globalForRetire.__vardo_traefik_forward_retired = true;
  } catch (err) {
    log.debug(`Couldn't remove the mesh Traefik forward yet: ${err instanceof Error ? err.message : err}`);
  }
}
