// Cheap security signals: processes from `docker top` and listening ports from the host's /proc, against a learned allow-set.

export type TopProcess = { pid: number; name: string; cpu: number; rssKb: number };

/** `docker top` reply for ps args `-eo pid,comm,pcpu,rss`. */
export function parseTop(reply: { Titles?: string[]; Processes?: string[][] } | null | undefined): TopProcess[] {
  const titles = (reply?.Titles ?? []).map((t) => t.trim().toUpperCase());
  const col = (...names: string[]) => titles.findIndex((t) => names.includes(t));
  const pid = col("PID");
  const name = col("COMMAND", "COMM", "CMD");
  const cpu = col("%CPU", "C");
  const rss = col("RSS", "RSZ");
  if (pid < 0 || name < 0) return [];
  return (reply?.Processes ?? []).flatMap((row) => {
    const n = Number(row[pid]);
    const comm = (row[name] ?? "").trim().split(/\s+/)[0]?.split("/").pop() ?? "";
    if (!Number.isInteger(n) || !comm) return [];
    return [{ pid: n, name: comm, cpu: cpu >= 0 ? Number(row[cpu]) || 0 : 0, rssKb: rss >= 0 ? Number(row[rss]) || 0 : 0 }];
  });
}

/** Loopback addresses, which nothing outside the container can reach. */
function isLoopback(hexAddr: string): boolean {
  if (hexAddr.length === 8) return hexAddr.slice(6, 8).toUpperCase() === "7F";
  const a = hexAddr.toUpperCase();
  if (a === "00000000000000000000000001000000") return true;
  return a.startsWith("0000000000000000FFFF0000") && a.slice(30, 32) === "7F";
}

/** Non-loopback listeners in a /proc/net/{tcp,tcp6,udp,udp6} table, as `tcp/8080`. */
export function parseListening(table: string, proto: "tcp" | "udp"): string[] {
  const listen = proto === "tcp" ? "0A" : "07";
  const out = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3].toUpperCase() !== listen) continue;
    const [addr, portHex] = cols[1].split(":");
    if (!addr || !portHex || isLoopback(addr)) continue;
    // A connected UDP socket has a remote port; only bound ones listen.
    if (proto === "udp" && !cols[2].endsWith(":0000")) continue;
    out.add(`${proto}/${parseInt(portHex, 16)}`);
  }
  return [...out];
}

export type SeenState = "known" | "pending" | "flagged";

export type SeenEntry = { state: SeenState; first: number; flaggedAt?: number };

export function encodeSeen(e: SeenEntry): string {
  return e.state === "flagged" ? `f:${e.first}:${e.flaggedAt ?? e.first}` : `${e.state === "known" ? "k" : "p"}:${e.first}`;
}

export function decodeSeen(raw: string): SeenEntry | null {
  const [s, first, flagged] = raw.split(":");
  const at = Number(first);
  if (!Number.isFinite(at)) return null;
  if (s === "k") return { state: "known", first: at };
  if (s === "p") return { state: "pending", first: at };
  if (s === "f") return { state: "flagged", first: at, flaggedAt: Number(flagged) || at };
  return null;
}

export type Reconciled = {
  /** Entries to write. */
  set: Map<string, SeenEntry>;
  /** Pending entries that didn't show again. */
  remove: string[];
  /** Newly flagged this sample. */
  flagged: string[];
};

/** Folds one sample into the allow-set. Learning allows all; after, a new item flags on its second sample in a row. */
export function reconcileSeen(existing: Map<string, SeenEntry>, current: Iterable<string>, now: number, learning: boolean): Reconciled {
  const seen = new Set(current);
  const set = new Map<string, SeenEntry>();
  const flagged: string[] = [];
  for (const item of seen) {
    const prev = existing.get(item);
    if (!prev) {
      set.set(item, { state: learning ? "known" : "pending", first: now });
    } else if (prev.state === "pending") {
      if (learning) set.set(item, { state: "known", first: prev.first });
      else {
        set.set(item, { state: "flagged", first: prev.first, flaggedAt: now });
        flagged.push(item);
      }
    }
  }
  const remove = [...existing].filter(([item, e]) => e.state === "pending" && !seen.has(item)).map(([item]) => item);
  return { set, remove, flagged };
}

/** Items flagged within `holdMs`, newest first. */
export function activeFindings(entries: Map<string, SeenEntry>, now: number, holdMs: number): { item: string; flaggedAt: number }[] {
  return [...entries]
    .filter(([, e]) => e.state === "flagged" && now - (e.flaggedAt ?? e.first) < holdMs)
    .map(([item, e]) => ({ item, flaggedAt: e.flaggedAt ?? e.first }))
    .sort((a, b) => b.flaggedAt - a.flaggedAt);
}
