import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { buildLogQLQuery, escapeLogQLString } = await import("@/lib/logging/client");
const { resolveLogEnvironment } = await import("@/lib/logging/scope");

describe("escapeLogQLString", () => {
  it("escapes backslashes, quotes and newlines", () => {
    expect(escapeLogQLString('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it("leaves backticks alone", () => {
    expect(escapeLogQLString("a`b")).toBe("a`b");
  });
});

describe("buildLogQLQuery", () => {
  it("builds label matchers and a case-insensitive search", () => {
    expect(buildLogQLQuery({ project: "web", environment: "production", service: "api", search: "error" }))
      .toBe('{project="web", environment="production", service="api"} |~ "(?i)error"');
  });

  it("keeps a quote in a label value inside the matcher", () => {
    const query = buildLogQLQuery({ project: "web", environment: 'x"} or {project=~".+' });
    expect(query).toBe('{project="web", environment="x\\"} or {project=~\\".+"}');
  });

  it("keeps a backtick in the search inside the line filter", () => {
    const query = buildLogQLQuery({ project: "web", search: "a` | json" });
    expect(query).toBe('{project="web"} |~ "(?i)a` \\\\| json"');
  });

  it("escapes regex metacharacters and then string-escapes them", () => {
    expect(buildLogQLQuery({ project: "web", search: 'a.b"c' }))
      .toBe('{project="web"} |~ "(?i)a\\\\.b\\"c"');
  });
});

describe("resolveLogEnvironment", () => {
  beforeEach(() => dbMock.reset());

  it("defaults to production without a lookup", async () => {
    expect(await resolveLogEnvironment({ id: "a1", parentAppId: null }, null)).toBe("production");
    expect(dbMock.query.environments.findFirst).not.toHaveBeenCalled();
  });

  it("returns a known environment", async () => {
    dbMock.query.environments.findFirst.mockResolvedValue({ name: "staging" });
    expect(await resolveLogEnvironment({ id: "a1", parentAppId: null }, "staging")).toBe("staging");
  });

  it("rejects an unknown environment", async () => {
    dbMock.query.environments.findFirst.mockResolvedValue(undefined);
    expect(await resolveLogEnvironment({ id: "a1", parentAppId: "p1" }, 'x"}')).toBeNull();
  });
});
