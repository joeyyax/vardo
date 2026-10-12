import { realpath } from "fs/promises";
import { dirname } from "path";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { recordActivity } from "@/lib/activity";
import { dockerRequest } from "@/lib/docker/client";
import { dockerEnv } from "@/lib/docker/docker-env";
import { GLOBAL_ENV_PATH, globalEnvValue } from "@/lib/docker/self-env";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { execFileAsync } from "@/lib/utils/exec";
import { logger } from "@/lib/logger";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { memoryMiB, parseSizeMb, traefikGoMemLimit, traefikMemMb } from "./defaults";

const log = logger.child("traefik-auto");
const SETTING = "traefik_auto_memory";
const COOLDOWN_MS = 60 * 60_000;

type AutoState = { limitMb: number; changedAt: number };

export function isTraefikAutoManaged(configuredMb: number | null, baselineMb: number, savedLimitMb: number | null): boolean {
  return savedLimitMb !== null ? configuredMb === savedLimitMb : configuredMb === null || configuredMb === baselineMb;
}

export function nextTraefikLimit(input: { usageBytes: number; limitBytes: number; hostUsedBytes: number; hostTotalBytes: number }): number | null {
  const { usageBytes, limitBytes, hostUsedBytes, hostTotalBytes } = input;
  if (!(limitBytes > 0 && hostTotalBytes > 0) || usageBytes / limitBytes < 0.85) return null;
  const current = Math.round(limitBytes / 1024 ** 2);
  const cap = Math.min(8192, Math.floor((hostTotalBytes / 1024 ** 2 / 8) / 64) * 64);
  const step = Math.max(256, Math.ceil((current / 4) / 64) * 64);
  const next = Math.min(cap, current + step);
  const reserve = Math.max(512, Math.ceil(hostTotalBytes / 1024 ** 2 / 10));
  const available = (hostTotalBytes - hostUsedBytes) / 1024 ** 2;
  return next > current && available >= next - current + reserve ? next : null;
}

function parseState(raw: string | null): AutoState | null {
  try {
    const value = JSON.parse(raw ?? "null") as AutoState | null;
    return value && Number.isFinite(value.limitMb) && Number.isFinite(value.changedAt) ? value : null;
  } catch {
    return null;
  }
}

async function persistLimit(limitMb: number, goLimit: string | null): Promise<void> {
  const dir = await realpath(dirname(GLOBAL_ENV_PATH));
  const pairs = [`VARDO_TRAEFIK_MEM=${limitMb}m`, ...(goLimit ? [`VARDO_TRAEFIK_GOMEMLIMIT=${goLimit}`] : [])];
  const script = 'set -e; file=/env/.env; test -f "$file"; for pair in "$@"; do key=${pair%%=*}; value=${pair#*=}; if grep -q "^$key=" "$file"; then sed -i "s/^$key=.*/$key=$value/" "$file"; else printf "\\n%s=%s\\n" "$key" "$value" >> "$file"; fi; done';
  await execFileAsync("docker", ["run", "--rm", "--log-driver", "none", "-v", `${dir}:/env`, "alpine", "sh", "-c", script, "sh", ...pairs], {
    env: dockerEnv(), timeout: 60_000,
  });
}

/** Grows a pressured Traefik container in place, then carries the limit into future deploys. */
export async function maybeGrowTraefik(input: {
  usageBytes: number;
  limitBytes: number;
  hostUsedBytes: number;
  hostTotalBytes: number;
}, now = Date.now()): Promise<boolean> {
  const next = nextTraefikLimit(input);
  if (next === null) return false;
  const lock = await acquireLock("traefik:auto-memory", 60_000);
  if (!lock) return false;
  try {
    const current = Math.round(input.limitBytes / 1024 ** 2);
    const [configured, configuredGo, savedRaw] = await Promise.all([
      globalEnvValue("VARDO_TRAEFIK_MEM"), globalEnvValue("VARDO_TRAEFIK_GOMEMLIMIT"), getSystemSettingRaw(SETTING),
    ]);
    const saved = parseState(savedRaw);
    if (saved && now - saved.changedAt < COOLDOWN_MS) return false;
    const baseline = traefikMemMb(memoryMiB(input.hostTotalBytes));
    const configuredMb = configured ? parseSizeMb(configured) : null;
    // A changed value after Vardo's last adjustment is a manual cap.
    if (!isTraefikAutoManaged(configuredMb, baseline, saved?.limitMb ?? null)) return false;
    const goLimit = !configuredGo || configuredGo === traefikGoMemLimit(configuredMb ?? current)
      ? traefikGoMemLimit(next) : null;
    await persistLimit(next, goLimit);
    await dockerRequest("POST", "/containers/vardo-traefik/update", { Memory: next * 1024 ** 2 });
    await setSystemSetting(SETTING, JSON.stringify({ limitMb: next, changedAt: now } satisfies AutoState));
    try {
      for (const organizationId of await adminOrgIds()) {
        await recordActivity({ organizationId, action: "system.traefik_memory_adjusted", metadata: { fromMb: current, toMb: next } });
      }
    } catch (error) {
      log.warn("Couldn't record Traefik memory activity:", error);
    }
    log.info(`Raised Traefik memory from ${current} MiB to ${next} MiB`);
    return true;
  } catch (error) {
    log.warn("Couldn't raise Traefik memory:", error);
    return false;
  } finally {
    await releaseLock("traefik:auto-memory", lock).catch(() => {});
  }
}
