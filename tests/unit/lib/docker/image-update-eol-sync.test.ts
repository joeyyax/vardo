import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async () => null),
  setSystemSetting: vi.fn(async () => {}),
}));
vi.mock("@/lib/security/safe-fetch", () => ({ safeFetch }));

import { parseProduct, syncEolTable, tableFrom, type StoredEol } from "@/lib/docker/image-updates/eol-sync";
import { EOL_TABLE, activeEolTable, findEol, setActiveEolTable } from "@/lib/docker/image-updates/eol";

const PRODUCTS = EOL_TABLE.filter((e) => e.product).map((e) => e.product!);

function memoryStore(initial: string | null = null) {
  let value = initial;
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async (next: string) => {
      value = next;
    }),
    get value() {
      return value;
    },
  };
}

const postgres = [
  { cycle: "19", eol: "2031-11-13" },
  { cycle: "14", eol: "2026-12-01" },
  { cycle: "20", eol: false },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => setActiveEolTable(null));
afterEach(() => {
  setActiveEolTable(null);
  vi.clearAllMocks();
});

describe("parseProduct", () => {
  it("keeps dated cycles and skips undated ones", () => {
    expect(parseProduct(postgres)).toEqual([
      { series: "19", eol: "2031-11-13" },
      { series: "14", eol: "2026-12-01" },
    ]);
  });

  it.each([
    ["an object", { cycle: "1" }],
    ["an empty list", []],
    ["a bad date", [{ cycle: "1", eol: "soon" }]],
    ["an absurd year", [{ cycle: "1", eol: "1970-01-01" }]],
    ["only undated cycles", [{ cycle: "1", eol: false }]],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseProduct(payload)).toThrow();
  });
});

describe("syncEolTable", () => {
  it("stores a valid refresh and makes it active", async () => {
    const store = memoryStore();
    const fetchProduct = vi.fn(async (product: string) => (product === "postgresql" ? postgres : [{ cycle: "1.0", eol: "2030-01-01" }]));

    expect(await syncEolTable({ fetchProduct, store })).toBe("updated");
    expect(fetchProduct).toHaveBeenCalledTimes(PRODUCTS.length);
    expect(findEol("postgres:19", "19")?.eol).toBe("2031-11-13");
    expect(findEol("postgres:14", "14")?.eol).toBe("2026-12-01");
    // Bundled series the API didn't list stay.
    expect(findEol("postgres:13", "13")?.eol).toBe("2025-11-13");
    const stored = JSON.parse(store.value!) as StoredEol;
    expect(stored.engines.postgres.find((s) => s.series === "19")).toBeTruthy();
  });

  it("keeps the last good dates when a payload doesn't validate", async () => {
    const lastGood: StoredEol = {
      fetchedAt: "2026-10-01T00:00:00.000Z",
      engines: { postgres: [{ series: "14", eol: "2027-01-01" }] },
    };
    const store = memoryStore(JSON.stringify(lastGood));
    const fetchProduct = vi.fn(async () => [{ cycle: "14", eol: "not a date" }]);

    expect(await syncEolTable({ fetchProduct, store })).toBe("kept");
    expect(findEol("postgres:14", "14")?.eol).toBe("2027-01-01");
    expect(store.write).not.toHaveBeenCalled();
  });

  it("keeps last good per engine on a partial failure", async () => {
    const lastGood: StoredEol = {
      fetchedAt: "2026-10-01T00:00:00.000Z",
      engines: { mysql: [{ series: "8.0", eol: "2027-04-30" }] },
    };
    const store = memoryStore(JSON.stringify(lastGood));
    const fetchProduct = vi.fn(async (product: string) => {
      if (product === "mysql") return { broken: true };
      return product === "postgresql" ? postgres : [{ cycle: "1.0", eol: "2030-01-01" }];
    });

    expect(await syncEolTable({ fetchProduct, store })).toBe("partial");
    expect(findEol("mysql:8.0", "8.0")?.eol).toBe("2027-04-30");
    expect(findEol("postgres:19", "19")?.eol).toBe("2031-11-13");
  });

  it("falls back to the bundled table on a network failure with nothing stored", async () => {
    const store = memoryStore();
    const fetchProduct = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    });

    expect(await syncEolTable({ fetchProduct, store })).toBe("bundled");
    expect(activeEolTable()).toBe(EOL_TABLE);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("ignores a stored table that doesn't validate", async () => {
    const store = memoryStore(JSON.stringify({ engines: { postgres: [{ series: "x", eol: "bad" }] } }));
    const fetchProduct = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await syncEolTable({ fetchProduct, store })).toBe("bundled");
    expect(findEol("postgres:14", "14")?.eol).toBe("2026-11-12");
  });

  it("fetches through safeFetch and retries a transient failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const store = memoryStore();
      let calls = 0;
      safeFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/postgresql.json") && calls++ === 0) return json({}, 503);
        return json(url.endsWith("/postgresql.json") ? postgres : [{ cycle: "1.0", eol: "2030-01-01" }]);
      });
      const run = syncEolTable({ store });
      await vi.runAllTimersAsync();
      expect(await run).toBe("updated");
      expect(safeFetch).toHaveBeenCalledWith("https://endoflife.date/api/postgresql.json", expect.any(Object));
      expect(calls).toBe(2);
      expect(findEol("postgres:19", "19")?.eol).toBe("2031-11-13");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tableFrom", () => {
  it("is the bundled table with nothing stored", () => {
    expect(tableFrom(null)).toBe(EOL_TABLE);
  });
});
