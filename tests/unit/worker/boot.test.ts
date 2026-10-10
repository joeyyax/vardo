import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { applied } = vi.hoisted(() => ({ applied: { value: [] as string[] | Error } }));

vi.mock("@/lib/db", () => ({
  db: {
    execute: vi.fn(async () => {
      if (applied.value instanceof Error) throw applied.value;
      return applied.value.map((hash) => ({ hash }));
    }),
  },
}));

import { assertSchemaCurrent, awaitBoot, bootState, journalTags, markStopping, missingMigrations, resetBootState } from "@/worker/boot";

afterEach(() => resetBootState());

describe("schema check", () => {
  it("reads every tag in this checkout's journal", async () => {
    const tags = await journalTags(join(process.cwd(), "drizzle"));
    expect(tags.length).toBeGreaterThan(100);
    expect(tags[0]).toMatch(/^0000_/);
  });

  it("lists the journal's tags the database lacks", () => {
    expect(missingMigrations(["0001_a", "0002_b", "0003_c"], ["0001_a", "0002_b"])).toEqual(["0003_c"]);
    expect(missingMigrations(["0001_a"], ["0001_a", "0099_newer"])).toEqual([]);
  });

  it("passes once every migration in the image is applied, and not before", async () => {
    const tags = await journalTags();
    applied.value = tags.slice(0, -1);
    await expect(assertSchemaCurrent()).rejects.toThrow(/1 migration\(s\) not applied yet/);
    applied.value = tags;
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();
  });
});

describe("awaitBoot", () => {
  it("retries with backoff until the step lands, reporting the error meanwhile", async () => {
    let calls = 0;
    const seen: (string | null)[] = [];
    const ok = await awaitBoot(
      "test",
      async () => {
        calls++;
        seen.push(bootState().bootError);
        if (calls < 3) throw new Error(`not yet ${calls}`);
      },
      { firstMs: 1, maxMs: 2 },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(seen).toEqual([null, "not yet 1", "not yet 2"]);
    expect(bootState().bootError).toBeNull();
  });

  it("gives up when a shutdown starts", async () => {
    const ok = await awaitBoot(
      "test",
      async () => {
        markStopping();
        throw new Error("down");
      },
      { firstMs: 1, maxMs: 1 },
    );
    expect(ok).toBe(false);
  });
});
