// An in-memory stand-in for the ioredis commands shared-state modules use. `down` makes every command reject.

type Entry = { value: string | Map<string, string> | Set<string> | Map<string, number>; kind: "string" | "hash" | "set" | "zset"; expiresAt: number | null };

export type FakeRedis = ReturnType<typeof createFakeRedis>;

export function createFakeRedis(clock: () => number = Date.now) {
  const data = new Map<string, Entry>();
  const ctl = { down: false };

  const live = (key: string): Entry | undefined => {
    const e = data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= clock()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const of = <K extends Entry["kind"]>(key: string, kind: K, make: () => Entry["value"]) => {
    let e = live(key);
    if (!e) {
      e = { value: make(), kind, expiresAt: null };
      data.set(key, e);
    }
    return e.value;
  };
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const guard = () => {
    if (ctl.down) throw new Error("Redis down");
  };

  const commands = {
    async set(key: string, value: string, ...args: (string | number)[]) {
      guard();
      const nx = args.includes("NX");
      if (nx && live(key)) return null;
      const px = args.indexOf("PX");
      const ex = args.indexOf("EX");
      const ttl = px >= 0 ? Number(args[px + 1]) : ex >= 0 ? Number(args[ex + 1]) * 1000 : null;
      data.set(key, { value: String(value), kind: "string", expiresAt: ttl === null ? null : clock() + ttl });
      return "OK";
    },
    async get(key: string) {
      guard();
      const e = live(key);
      return e?.kind === "string" ? (e.value as string) : null;
    },
    async mget(...keys: string[]) {
      guard();
      return keys.map((k) => {
        const e = live(k);
        return e?.kind === "string" ? (e.value as string) : null;
      });
    },
    async del(...keys: string[]) {
      guard();
      let n = 0;
      for (const k of keys) if (live(k) && data.delete(k)) n++;
      return n;
    },
    async exists(...keys: string[]) {
      guard();
      return keys.filter((k) => live(k)).length;
    },
    async scan(_cursor: string, ...args: (string | number)[]) {
      guard();
      const m = args.indexOf("MATCH");
      const re = glob(m >= 0 ? String(args[m + 1]) : "*");
      return ["0", [...data.keys()].filter((k) => live(k) && re.test(k))] as [string, string[]];
    },
    async pexpire(key: string, ms: number, mode?: "NX") {
      guard();
      const e = live(key);
      if (!e) return 0;
      if (mode === "NX" && e.expiresAt !== null) return 0;
      e.expiresAt = clock() + ms;
      return 1;
    },
    async pttl(key: string) {
      guard();
      const e = live(key);
      if (!e) return -2;
      return e.expiresAt === null ? -1 : e.expiresAt - clock();
    },
    async hset(key: string, ...args: unknown[]) {
      guard();
      const h = of(key, "hash", () => new Map()) as Map<string, string>;
      const pairs: [string, string][] =
        args.length === 1 && typeof args[0] === "object"
          ? Object.entries(args[0] as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          : Array.from({ length: args.length / 2 }, (_, i) => [String(args[2 * i]), String(args[2 * i + 1])]);
      for (const [k, v] of pairs) h.set(k, v);
      return pairs.length;
    },
    async hsetnx(key: string, field: string, value: string | number) {
      guard();
      const h = of(key, "hash", () => new Map()) as Map<string, string>;
      if (h.has(field)) return 0;
      h.set(field, String(value));
      return 1;
    },
    async hincrby(key: string, field: string, by: number) {
      guard();
      const h = of(key, "hash", () => new Map()) as Map<string, string>;
      const next = Number(h.get(field) ?? 0) + by;
      h.set(field, String(next));
      return next;
    },
    async hgetall(key: string) {
      guard();
      const e = live(key);
      return e?.kind === "hash" ? Object.fromEntries(e.value as Map<string, string>) : {};
    },
    async sadd(key: string, ...members: string[]) {
      guard();
      const s = of(key, "set", () => new Set()) as Set<string>;
      for (const m of members) s.add(m);
      return members.length;
    },
    async smembers(key: string) {
      guard();
      const e = live(key);
      return e?.kind === "set" ? [...(e.value as Set<string>)] : [];
    },
    async srem(key: string, ...members: string[]) {
      guard();
      const e = live(key);
      if (e?.kind !== "set") return 0;
      for (const m of members) (e.value as Set<string>).delete(m);
      return members.length;
    },
    async zadd(key: string, ...args: (string | number)[]) {
      guard();
      const z = of(key, "zset", () => new Map()) as Map<string, number>;
      const gt = args[0] === "GT";
      const rest = gt ? args.slice(1) : args;
      for (let i = 0; i < rest.length; i += 2) {
        const score = Number(rest[i]);
        const member = String(rest[i + 1]);
        const had = z.get(member);
        if (!gt || had === undefined || score > had) z.set(member, score);
      }
      return rest.length / 2;
    },
    async zrangebyscore(key: string, min: string | number, max: string | number, withScores?: "WITHSCORES") {
      guard();
      const e = live(key);
      if (e?.kind !== "zset") return [];
      const lo = min === "-inf" ? -Infinity : String(min).startsWith("(") ? Number(String(min).slice(1)) + Number.EPSILON : Number(min);
      const hi = max === "+inf" ? Infinity : Number(max);
      const hits = [...(e.value as Map<string, number>)].filter(([, s]) => s >= lo && s <= hi).sort((a, b) => a[1] - b[1]);
      return withScores ? hits.flatMap(([m, s]) => [m, String(s)]) : hits.map(([m]) => m);
    },
    async zremrangebyscore(key: string, min: string | number, max: string | number) {
      guard();
      const e = live(key);
      if (e?.kind !== "zset") return 0;
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ? Infinity : String(max).startsWith("(") ? Number(String(max).slice(1)) - Number.EPSILON : Number(max);
      let n = 0;
      for (const [m, s] of e.value as Map<string, number>) if (s >= lo && s <= hi && (e.value as Map<string, number>).delete(m)) n++;
      return n;
    },
  };

  type Commands = typeof commands;
  const multi = () => {
    const queued: (() => Promise<unknown>)[] = [];
    const chain = new Proxy({} as Record<string, unknown>, {
      get(_, prop: string) {
        if (prop === "exec") {
          return async () => {
            guard();
            const out: [Error | null, unknown][] = [];
            for (const run of queued) out.push([null, await run()]);
            return out;
          };
        }
        return (...args: unknown[]) => {
          queued.push(() => (commands[prop as keyof Commands] as (...a: unknown[]) => Promise<unknown>)(...args));
          return chain;
        };
      },
    });
    return chain;
  };

  return { ...commands, multi, pipeline: multi, ctl, data };
}
