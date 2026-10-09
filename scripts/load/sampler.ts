import { spawn } from "node:child_process";

export type ContainerPeak = { cpuPct: number; memMiB: number };

export type ServerPeaks = {
  samples: number;
  containers: Record<string, ContainerPeak>;
  redisUsedMiB: number | null;
  redisPeakMiB: number | null;
  pgConnections: number | null;
};

const MARK = "@@";

// One ssh round trip per tick. Container names differ between plain and blue-green installs, so match on substrings.
export const REMOTE_SCRIPT = `
names=$(docker ps --format '{{.Names}}' | grep -i vardo)
echo "${MARK}stats"
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $names
redis=$(echo "$names" | grep -i redis | head -1)
pg=$(echo "$names" | grep -i postgres | head -1)
echo "${MARK}redis"
[ -n "$redis" ] && docker exec "$redis" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli INFO memory' 2>/dev/null
echo "${MARK}pg"
[ -n "$pg" ] && docker exec "$pg" sh -c 'psql -U "\${POSTGRES_USER:-host}" -d "\${POSTGRES_DB:-host}" -tAc "select count(*) from pg_stat_activity"' 2>/dev/null
true
`;

const UNIT_MIB: Record<string, number> = { b: 1 / 1048576, kib: 1 / 1024, mib: 1, gib: 1024, tib: 1048576 };

export function toMiB(text: string): number | null {
  const m = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim());
  if (!m) return null;
  const factor = UNIT_MIB[m[2].toLowerCase()];
  return factor === undefined ? null : Number(m[1]) * factor;
}

export type Tick = {
  containers: Record<string, ContainerPeak>;
  redisUsedMiB: number | null;
  redisPeakMiB: number | null;
  pgConnections: number | null;
};

/** Parses the output of REMOTE_SCRIPT. */
export function parseTick(output: string): Tick {
  const sections: Record<string, string[]> = {};
  let current = "";
  for (const line of output.split("\n")) {
    if (line.startsWith(MARK)) {
      current = line.slice(MARK.length).trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line.trim());
    }
  }

  const containers: Record<string, ContainerPeak> = {};
  for (const line of sections.stats ?? []) {
    // name cpu% used / limit
    const m = /^(\S+)\s+([\d.]+)%\s+(\S+)\s*\/\s*\S+/.exec(line);
    const mem = m ? toMiB(m[3]) : null;
    if (m && mem !== null) containers[m[1]] = { cpuPct: Number(m[2]), memMiB: mem };
  }

  const redisField = (key: string) => {
    const line = (sections.redis ?? []).find((l) => l.startsWith(`${key}:`));
    return line ? Number(line.slice(key.length + 1)) / 1048576 : null;
  };
  const pg = Number((sections.pg ?? []).find((l) => /^\d+$/.test(l)));

  return {
    containers,
    redisUsedMiB: redisField("used_memory"),
    redisPeakMiB: redisField("used_memory_peak"),
    pgConnections: Number.isFinite(pg) && (sections.pg ?? []).some((l) => /^\d+$/.test(l)) ? pg : null,
  };
}

export function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Folds a tick into running peaks. */
export function mergeTick(peaks: ServerPeaks, tick: Tick): ServerPeaks {
  const containers = { ...peaks.containers };
  for (const [name, c] of Object.entries(tick.containers)) {
    const prev = containers[name];
    containers[name] = {
      cpuPct: Math.max(prev?.cpuPct ?? 0, c.cpuPct),
      memMiB: Math.max(prev?.memMiB ?? 0, c.memMiB),
    };
  }
  return {
    samples: peaks.samples + 1,
    containers,
    redisUsedMiB: maxOf(peaks.redisUsedMiB, tick.redisUsedMiB),
    redisPeakMiB: maxOf(peaks.redisPeakMiB, tick.redisPeakMiB),
    pgConnections: maxOf(peaks.pgConnections, tick.pgConnections),
  };
}

function runRemote(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "bash -s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `ssh exited ${code}`))));
    child.stdin.end(REMOTE_SCRIPT);
  });
}

/** Samples back to back until `stop()`. Failed ticks are counted, not fatal. */
export function startSampler(host: string) {
  let peaks: ServerPeaks = {
    samples: 0,
    containers: {},
    redisUsedMiB: null,
    redisPeakMiB: null,
    pgConnections: null,
  };
  let running = true;
  let lastError: string | null = null;

  const loop = (async () => {
    while (running) {
      try {
        peaks = mergeTick(peaks, parseTick(await runRemote(host)));
      } catch (err) {
        lastError = (err as Error).message;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      return { peaks, error: peaks.samples === 0 ? lastError : null };
    },
  };
}
