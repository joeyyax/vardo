import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  BUNDLED_RANGES,
  CLOUDFLARE_ONLY_FILE,
  fetchCloudflareRanges,
  parseRangeList,
  readRenderedRanges,
  renderCloudflareOnly,
  syncCloudflareOnly,
} from "@/lib/docker/cloudflare-only";

const V4 = BUNDLED_RANGES.v4.join("\n") + "\n";
const V6 = BUNDLED_RANGES.v6.join("\n") + "\n";

describe("parseRangeList", () => {
  it("reads one CIDR per line", () => {
    expect(parseRangeList(V4, 4)).toEqual({ ranges: BUNDLED_RANGES.v4 });
    expect(parseRangeList(V6, 6)).toEqual({ ranges: BUNDLED_RANGES.v6 });
  });

  it("refuses an error page, the wrong family or a short list", () => {
    expect(parseRangeList("<html>rate limited</html>", 4)).toHaveProperty("error");
    expect(parseRangeList(V6, 4)).toHaveProperty("error");
    expect(parseRangeList("1.2.3.0/24\n", 4)).toHaveProperty("error");
    expect(parseRangeList(V4.replace("/20", "/33"), 4)).toHaveProperty("error");
  });
});

describe("renderCloudflareOnly", () => {
  it("defines the middleware Traefik reads", () => {
    const parsed = YAML.parse(renderCloudflareOnly(BUNDLED_RANGES));
    expect(parsed.http.middlewares["cloudflare-only"].ipAllowList.sourceRange).toEqual([...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6]);
    expect(readRenderedRanges(renderCloudflareOnly(BUNDLED_RANGES))).toHaveLength(22);
  });
});

describe("fetchCloudflareRanges", () => {
  it("fetches both lists", async () => {
    const fetcher = vi.fn(async (url: string) => (url.endsWith("v4") ? V4 : V6));
    await expect(fetchCloudflareRanges(fetcher)).resolves.toEqual(BUNDLED_RANGES);
  });

  it("throws on a list that doesn't validate", async () => {
    await expect(fetchCloudflareRanges(async () => "nope")).rejects.toThrow(/ips-v4/);
  });
});

describe("syncCloudflareOnly", () => {
  let dir: string;
  const file = () => join(dir, CLOUDFLARE_ONLY_FILE);
  const fresh = { v4: [...BUNDLED_RANGES.v4, "198.51.100.0/24"], v6: BUNDLED_RANGES.v6 };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cf-only-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the fetched ranges", async () => {
    expect(await syncCloudflareOnly({ dir, fetchRanges: async () => fresh })).toBe("updated");
    expect(readRenderedRanges(await readFile(file(), "utf-8"))).toContain("198.51.100.0/24");
  });

  it("leaves an identical file alone", async () => {
    await syncCloudflareOnly({ dir, fetchRanges: async () => fresh });
    expect(await syncCloudflareOnly({ dir, fetchRanges: async () => fresh })).toBe("unchanged");
  });

  it("keeps the last good file when the fetch fails", async () => {
    await syncCloudflareOnly({ dir, fetchRanges: async () => fresh });
    const before = await readFile(file(), "utf-8");
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await syncCloudflareOnly({ dir, fetchRanges: failing })).toBe("kept");
    expect(await readFile(file(), "utf-8")).toBe(before);
  });

  it("writes the bundled ranges when there's no file and no fetch", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await syncCloudflareOnly({ dir, fetchRanges: failing })).toBe("bundled");
    expect(readRenderedRanges(await readFile(file(), "utf-8"))).toEqual([...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6]);
  });

  it("replaces a broken file with the bundled ranges when the fetch fails", async () => {
    await writeFile(file(), "http: [broken");
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await syncCloudflareOnly({ dir, fetchRanges: failing })).toBe("bundled");
  });
});
