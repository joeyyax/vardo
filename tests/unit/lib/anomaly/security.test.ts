import { describe, expect, it } from "vitest";
import { activeFindings, decodeSeen, encodeSeen, parseListening, parseTop, reconcileSeen, type SeenEntry } from "@/lib/anomaly/security";

const MIN = 60_000;
const now = 1_000 * MIN;

describe("parseTop", () => {
  it("reads pid, name, CPU and memory", () => {
    const procs = parseTop({
      Titles: ["PID", "COMMAND", "%CPU", "RSS"],
      Processes: [
        ["4211", "node", "3.5", "81234"],
        ["4302", "/usr/bin/worker", "92.0", "1200"],
        ["x", "bad", "0", "0"],
      ],
    });
    expect(procs).toEqual([
      { pid: 4211, name: "node", cpu: 3.5, rssKb: 81234 },
      { pid: 4302, name: "worker", cpu: 92, rssKb: 1200 },
    ]);
  });

  it("reads the default ps -ef layout", () => {
    const procs = parseTop({ Titles: ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"], Processes: [["root", "10", "1", "0", "12:00", "?", "00:00:01", "nginx: master"]] });
    expect(procs).toEqual([{ pid: 10, name: "nginx:", cpu: 0, rssKb: 0 }]);
  });

  it("is empty without a pid column", () => {
    expect(parseTop({ Titles: ["COMMAND"], Processes: [["node"]] })).toEqual([]);
    expect(parseTop(null)).toEqual([]);
  });
});

describe("parseListening", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
    "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2",
    "   2: 0200A8C0:0BB8 0100A8C0:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3",
  ].join("\n");

  it("lists listening sockets and skips loopback and connections", () => {
    expect(parseListening(tcp, "tcp")).toEqual(["tcp/3000"]);
  });

  it("reads IPv6 tables and skips ::1", () => {
    const tcp6 = [
      "  sl  local_address                         remote_address                        st",
      "   0: 00000000000000000000000000000000:115C 00000000000000000000000000000000:0000 0A",
      "   1: 00000000000000000000000001000000:2382 00000000000000000000000000000000:0000 0A",
    ].join("\n");
    expect(parseListening(tcp6, "tcp")).toEqual(["tcp/4444"]);
  });

  it("reads bound UDP sockets", () => {
    const udp = ["  sl  local_address rem_address   st", "   0: 00000000:14E9 00000000:0000 07"].join("\n");
    expect(parseListening(udp, "udp")).toEqual(["udp/5353"]);
  });
});

describe("allow-set", () => {
  const known = (first = now - 5 * 24 * 60 * MIN): SeenEntry => ({ state: "known", first });

  it("learns everything while warming up or in a quiet window", () => {
    const r = reconcileSeen(new Map(), ["node", "sh"], now, true);
    expect([...r.set.values()].every((e) => e.state === "known")).toBe(true);
    expect(r.flagged).toEqual([]);
  });

  it("flags a new item only once it shows in two samples in a row", () => {
    const first = reconcileSeen(new Map([["node", known()]]), ["node", "miner"], now, false);
    expect(first.set.get("miner")).toEqual({ state: "pending", first: now });
    expect(first.flagged).toEqual([]);

    const existing = new Map([["node", known()], ["miner", first.set.get("miner")!]]);
    const second = reconcileSeen(existing, ["node", "miner"], now + 10 * MIN, false);
    expect(second.flagged).toEqual(["miner"]);
    expect(second.set.get("miner")).toEqual({ state: "flagged", first: now, flaggedAt: now + 10 * MIN });
  });

  it("drops a one-off that didn't come back", () => {
    const existing = new Map<string, SeenEntry>([["node", known()], ["curl", { state: "pending", first: now }]]);
    const r = reconcileSeen(existing, ["node"], now + 10 * MIN, false);
    expect(r.remove).toEqual(["curl"]);
    expect(r.flagged).toEqual([]);
  });

  it("never flags the same item twice", () => {
    const existing = new Map<string, SeenEntry>([["miner", { state: "flagged", first: now, flaggedAt: now }]]);
    expect(reconcileSeen(existing, ["miner"], now + 60 * MIN, false)).toEqual({ set: new Map(), remove: [], flagged: [] });
  });

  it("holds a finding for the hold window", () => {
    const entries = new Map<string, SeenEntry>([
      ["miner", { state: "flagged", first: now, flaggedAt: now }],
      ["node", known()],
    ]);
    expect(activeFindings(entries, now + 30 * MIN, 60 * MIN)).toEqual([{ item: "miner", flaggedAt: now }]);
    expect(activeFindings(entries, now + 60 * MIN, 60 * MIN)).toEqual([]);
  });

  it("round-trips entries through Redis strings", () => {
    for (const e of [known(5), { state: "pending", first: 7 }, { state: "flagged", first: 7, flaggedAt: 9 }] as SeenEntry[]) {
      expect(decodeSeen(encodeSeen(e))).toEqual(e);
    }
    expect(decodeSeen("garbage")).toBeNull();
  });
});
