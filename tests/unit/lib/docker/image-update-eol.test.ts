import { describe, it, expect } from "vitest";
import {
  EOL_TABLE,
  EOL_WARN_DAYS,
  describeEol,
  eolNotice,
  findEol,
  mergeEolTables,
} from "@/lib/docker/image-updates/eol";

const at = (iso: string) => Date.parse(iso);

describe("EOL table", () => {
  it("covers the common stateful engines", () => {
    const ids = EOL_TABLE.map((e) => e.id);
    for (const id of ["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "elasticsearch", "opensearch", "rabbitmq"]) {
      expect(ids).toContain(id);
    }
  });

  it("has a source and valid dates for every series", () => {
    for (const engine of EOL_TABLE) {
      expect(engine.source).toMatch(/^https:\/\//);
      for (const entry of engine.series) {
        expect(entry.eol, `${engine.id} ${entry.series}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(entry.eol))).toBe(false);
        expect(entry.series).toMatch(/^\d+(\.\d+)*$/);
      }
    }
  });
});

describe("findEol", () => {
  it("matches a postgres major from a full tag and a flavor", () => {
    expect(findEol("postgres:13.4-alpine", "13.4-alpine")).toMatchObject({ engine: "postgres", series: "13", eol: "2025-11-13" });
    expect(findEol("docker.io/library/postgres:16", "16")?.series).toBe("16");
    expect(findEol("postgis/postgis:15-3.4", "15-3.4")?.series).toBe("15");
  });

  it("takes the longest series prefix and compares parts as numbers", () => {
    expect(findEol("mariadb:10.11.6", "10.11.6")?.series).toBe("10.11");
    expect(findEol("mariadb:10.6", "10.6")?.series).toBe("10.6");
    expect(findEol("mysql:8.0.36", "8.0.36")?.series).toBe("8.0");
    expect(findEol("mongo:7.0.12", "7.0.12")?.series).toBe("7.0");
    expect(findEol("mongo:7", "7")?.series).toBe("7");
  });

  it("returns null for unknown engines, floating tags and ambiguous majors", () => {
    expect(findEol("nginx:1.25", "1.25")).toBeNull();
    expect(findEol("postgres:latest", "latest")).toBeNull();
    expect(findEol("mysql:8", "8")).toBeNull();
    expect(findEol("postgres:99", "99")).toBeNull();
  });
});

describe("eolNotice", () => {
  it("is quiet when the date is more than the warning window away", () => {
    expect(eolNotice("postgres:16", "16", at("2026-10-10T00:00:00Z"))).toBeNull();
  });

  it("warns inside the window", () => {
    const notice = eolNotice("postgres:14", "14", at("2026-10-10T00:00:00Z"));
    expect(notice).toMatchObject({ state: "ending", series: "14" });
    expect(notice!.daysLeft).toBeGreaterThan(0);
    expect(notice!.daysLeft).toBeLessThanOrEqual(EOL_WARN_DAYS);
  });

  it("starts warning exactly at the window edge", () => {
    expect(eolNotice("postgres:14", "14", at("2026-08-15T00:00:00Z"))?.daysLeft).toBe(90);
    expect(eolNotice("postgres:14", "14", at("2026-08-13T00:00:00Z"))).toBeNull();
  });

  it("reports an ended series", () => {
    expect(eolNotice("postgres:13", "13", at("2026-10-10T00:00:00Z"))).toMatchObject({ state: "ended" });
  });

  it("counts the EOL day itself as still supported", () => {
    expect(eolNotice("postgres:13", "13", at("2025-11-13T12:00:00Z"))?.state).toBe("ending");
    expect(eolNotice("postgres:13", "13", at("2025-11-14T00:00:01Z"))?.state).toBe("ended");
  });

  it("takes a custom table and window", () => {
    const table = [{ id: "x", label: "X", match: /^x$/, source: "https://example.com", series: [{ series: "1", eol: "2030-01-01" }] }];
    expect(eolNotice("x:1", "1", at("2026-10-10T00:00:00Z"), { table })).toBeNull();
    expect(eolNotice("x:1", "1", at("2026-10-10T00:00:00Z"), { table, warnDays: 2000 })?.state).toBe("ending");
  });
});

describe("mergeEolTables", () => {
  it("replaces a series by name, adds new ones and leaves the base alone", () => {
    const merged = mergeEolTables(EOL_TABLE, [
      { id: "postgres", label: "PostgreSQL", match: /x/, source: "", series: [{ series: "13", eol: "2030-01-01" }, { series: "19", eol: "2031-11-13" }] },
      { id: "clickhouse", label: "ClickHouse", match: /^clickhouse-server$/, source: "https://clickhouse.com", series: [{ series: "24.3", eol: "2025-03-01" }] },
    ]);
    expect(findEol("postgres:13", "13", merged)?.eol).toBe("2030-01-01");
    expect(findEol("postgres:19", "19", merged)?.eol).toBe("2031-11-13");
    expect(findEol("clickhouse/clickhouse-server:24.3", "24.3", merged)?.engine).toBe("clickhouse");
    expect(findEol("postgres:13", "13")?.eol).toBe("2025-11-13");
  });
});

describe("describeEol", () => {
  it("reads plainly in both tenses", () => {
    const ended = eolNotice("postgres:13", "13", at("2026-10-10T00:00:00Z"))!;
    expect(describeEol(ended)).toBe("PostgreSQL 13 stopped getting security fixes on Nov 13, 2025.");
    const ending = eolNotice("postgres:14", "14", at("2026-10-10T00:00:00Z"))!;
    expect(describeEol(ending)).toBe("PostgreSQL 14 stops getting security fixes on Nov 12, 2026.");
  });
});
