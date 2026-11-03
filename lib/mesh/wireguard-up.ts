// Starts a stopped vardo-wireguard, first moving any container that took one of its fixed addresses.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { WG_CONTAINER } from "./constants";

const log = logger.child("mesh-wireguard");

type Fixed = { network: string; ip: string };
type Squatter = { network: string; name: string; ip: string };

const docker = (args: string[]) => execFileAsync("docker", args, { env: dockerEnv() });

/** Running state and fixed addresses from `docker inspect` output of `true net=ip net=`. */
export function parseWgInspect(stdout: string): { running: boolean; fixed: Fixed[] } {
  const [running, ...pairs] = stdout.trim().split(/\s+/);
  const fixed = pairs
    .map((p) => p.split("="))
    .filter(([network, ip]) => network && ip)
    .map(([network, ip]) => ({ network, ip }));
  return { running: running === "true", fixed };
}

/** Containers other than WireGuard holding `fixed.ip`, from `docker network inspect` lines of `name ip/prefix`. */
export function parseSquatters(stdout: string, fixed: Fixed): Squatter[] {
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([name, cidr]) => name && name !== WG_CONTAINER && cidr?.split("/")[0] === fixed.ip)
    .map(([name]) => ({ network: fixed.network, name, ip: fixed.ip }));
}

async function inspectWg(): Promise<{ running: boolean; fixed: Fixed[] } | null> {
  try {
    const { stdout } = await docker([
      "inspect", "-f",
      "{{.State.Running}}{{range $k, $v := .NetworkSettings.Networks}} {{$k}}={{if $v.IPAMConfig}}{{$v.IPAMConfig.IPv4Address}}{{end}}{{end}}",
      WG_CONTAINER,
    ]);
    return parseWgInspect(stdout);
  } catch {
    return null;
  }
}

async function squattersOf(fixed: Fixed[]): Promise<Squatter[]> {
  const found: Squatter[] = [];
  for (const f of fixed) {
    const { stdout } = await docker([
      "network", "inspect", f.network, "-f", "{{range .Containers}}{{.Name}} {{.IPv4Address}}\n{{end}}",
    ]);
    found.push(...parseSquatters(stdout, f));
  }
  return found;
}

export type WireguardUp = "running" | "started" | "absent" | "failed";

/** Start vardo-wireguard when it's stopped. A squatter is reconnected afterwards on a new address. */
export async function ensureWireguardRunning(): Promise<WireguardUp> {
  const state = await inspectWg();
  if (!state) return "absent";
  if (state.running) return "running";

  const squatters = await squattersOf(state.fixed);
  for (const s of squatters) await docker(["network", "disconnect", s.network, s.name]);
  try {
    await docker(["start", WG_CONTAINER]);
  } catch (err) {
    log.error(`${WG_CONTAINER} is stopped and won't start: ${err instanceof Error ? err.message : err}`);
    return "failed";
  } finally {
    for (const s of squatters) {
      await docker(["network", "connect", s.network, s.name]).catch((err) =>
        log.error(`Couldn't reconnect ${s.name} to ${s.network}: ${err instanceof Error ? err.message : err}`),
      );
    }
  }
  const moved = squatters.map((s) => `${s.name} off ${s.ip}`).join(", ");
  log.warn(`Started ${WG_CONTAINER}${moved ? ` after moving ${moved}` : ""}`);
  return "started";
}
