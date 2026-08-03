import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { statusChange } from "@/lib/db/app-status";

const dialect = new PgDialect();
const NOW = new Date("2026-08-03T03:58:57.000Z");

function stamp(status: Parameters<typeof statusChange>[0], now = NOW) {
  return dialect.sqlToQuery(statusChange(status, now).statusChangedAt);
}

describe("statusChange", () => {
  it("writes the status and the same clock to updatedAt", () => {
    const set = statusChange("stopped", NOW);

    expect(set.status).toBe("stopped");
    expect(set.updatedAt).toBe(NOW);
  });

  it("moves the stamp only when the stored status differs", () => {
    const { sql, params } = stamp("stopped");

    expect(sql).toContain('"app"."status" = ');
    expect(sql).toContain('then "app"."status_changed_at"');
    expect(params).toEqual(["stopped", NOW.toISOString()]);
  });

  it("compares against the status being written, not a fixed one", () => {
    expect(stamp("active").params[0]).toBe("active");
    expect(stamp("missing").params[0]).toBe("missing");
  });
});
