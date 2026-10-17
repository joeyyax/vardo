import { describe, it, expect } from "vitest";
import { databaseKind, leakCandidates, type VolumeFacts } from "@/lib/backups/leaked-volumes";

const hex = (c: string) => c.repeat(64);
const vol = (over: Partial<VolumeFacts>): VolumeFacts => ({
  name: hex("a"),
  labels: {},
  createdAt: "2026-10-12T04:00:00Z",
  markers: "/v/ibdata1\n",
  sizeKb: 1024,
  ...over,
});
const since = new Date("2026-10-09");

describe("databaseKind", () => {
  it("tells the engines apart by marker file", () => {
    expect(databaseKind("/v/18/docker/PG_VERSION")).toBe("postgres");
    expect(databaseKind("/v/ibdata1\n/v/aria_log_control")).toBe("mariadb");
    expect(databaseKind("/v/ibdata1")).toBe("mysql");
    expect(databaseKind("/v/README")).toBeNull();
  });
});

describe("leakCandidates", () => {
  it("lists anonymous database volumes created since the cutoff", () => {
    expect(leakCandidates([vol({})], { since })).toHaveLength(1);
  });

  it("skips named volumes, non-databases and volumes older than the cutoff", () => {
    const found = leakCandidates(
      [vol({ name: "myapp_data" }), vol({ name: hex("b"), markers: "" }), vol({ name: hex("c"), createdAt: "2026-09-01T00:00:00Z" })],
      { since },
    );
    expect(found).toEqual([]);
  });

  it("always lists drill-labeled volumes, whatever their age", () => {
    const found = leakCandidates([vol({ name: "x", labels: { "vardo.scratch": "drill" }, createdAt: "2020-01-01T00:00:00Z" })], { since });
    expect(found.map((c) => c.labeled)).toEqual([true]);
  });
});
