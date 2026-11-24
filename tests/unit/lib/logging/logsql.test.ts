import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { buildLogsQLQuery } = await import("@/lib/logging/victorialogs");
const { resolveLogEnvironment } = await import("@/lib/logging/scope");

// What VictoriaLogs makes of these is checked against a real server in
// tests/integration/victorialogs.test.ts. Here: a viewer value never leaves its literal.

describe("buildLogsQLQuery", () => {
  it("filters on the app, environment and service the viewer picked, and searches the line", () => {
    expect(buildLogsQLQuery({ project: "web", environment: "production", service: "api", search: "error" }))
      .toBe('"vardo.project":="web" "vardo.environment":="production" compose_service:="api" _msg:~"(?i)error"');
  });

  it("leaves out the filters the viewer didn't set", () => {
    expect(buildLogsQLQuery({ project: "web" })).toBe('"vardo.project":="web"');
  });

  it("keeps a quote in a value inside its literal", () => {
    const query = buildLogsQLQuery({ project: "web", environment: 'x" or "vardo.project":*' });
    expect(query).toBe('"vardo.project":="web" "vardo.environment":="x\\" or \\"vardo.project\\":*"');
  });

  it("keeps a pipe in the search inside the regex, escaped as a literal", () => {
    expect(buildLogsQLQuery({ project: "web", search: "a | delete" }))
      .toBe('"vardo.project":="web" _msg:~"(?i)a \\\\| delete"');
  });

  it("escapes regex metacharacters and then string-escapes them", () => {
    expect(buildLogsQLQuery({ project: "web", search: 'a.b"c' }))
      .toBe('"vardo.project":="web" _msg:~"(?i)a\\\\.b\\"c"');
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
