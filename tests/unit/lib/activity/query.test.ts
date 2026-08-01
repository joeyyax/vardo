import { describe, it, expect, vi } from "vitest";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/db", () => ({ db: {} }));

import { activityConditions } from "@/lib/activity/query";
import type { ActivityFilters } from "@/lib/activity/types";

const dialect = new PgDialect();

function render(filters: Partial<ActivityFilters>, appId?: string) {
  const conditions = activityConditions(
    { orgId: "org-1", appId },
    { families: [], outcomes: [], since: null, ...filters }
  );
  return dialect.sqlToQuery(and(...conditions)!);
}

describe("activityConditions", () => {
  it("scopes to the organization and nothing else by default", () => {
    const { sql, params } = render({});
    expect(sql).toContain('"organization_id"');
    expect(sql).not.toContain('"family"');
    expect(sql).not.toContain('"outcome"');
    expect(params).toEqual(["org-1"]);
  });

  it("pushes family and outcome into the query", () => {
    const { sql, params } = render({
      families: ["deploy", "backup"],
      outcomes: ["failure"],
    });
    expect(sql).toContain('"family" in');
    expect(sql).toContain('"outcome" in');
    expect(params).toEqual(["org-1", "deploy", "backup", "failure"]);
  });

  it("pushes the window start into the query", () => {
    const since = new Date("2026-07-31T00:00:00Z");
    const { sql, params } = render({ since });
    expect(sql).toContain('"created_at" >=');
    expect(params).toEqual(["org-1", since.toISOString()]);
  });

  it("narrows to one app when asked", () => {
    const { sql, params } = render({}, "app-1");
    expect(sql).toContain('"app_id"');
    expect(params).toEqual(["org-1", "app-1"]);
  });
});
