import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { apiError, describeIssue, fieldLabel, handleRouteError } from "@/lib/api/error-response";

function firstIssue(schema: z.ZodType, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected failure");
  return r.error.issues[0];
}

describe("fieldLabel", () => {
  it("humanizes keys and keeps acronyms", () => {
    expect(fieldLabel("gitUrl")).toBe("Git URL");
    expect(fieldLabel("memory_limit")).toBe("Memory limit");
    expect(fieldLabel("name")).toBe("Name");
  });
});

describe("describeIssue", () => {
  it("reports missing fields as required", () => {
    expect(describeIssue(firstIssue(z.object({ name: z.string() }), {}))).toBe("Name is required.");
    expect(describeIssue(firstIssue(z.object({ name: z.string().min(1) }), { name: "" }))).toBe(
      "Name is required.",
    );
  });

  it("keeps custom messages and adds a period", () => {
    const schema = z.object({ cron: z.string().refine(() => false, "Invalid cron expression") });
    expect(describeIssue(firstIssue(schema, { cron: "x" }))).toBe("Invalid cron expression.");
  });

  it("describes length, format and enum failures", () => {
    expect(describeIssue(firstIssue(z.object({ slug: z.string().max(3) }), { slug: "abcd" }))).toBe(
      "Slug must be at most 3 characters.",
    );
    expect(describeIssue(firstIssue(z.object({ gitUrl: z.url() }), { gitUrl: "x" }))).toBe(
      "Git URL isn't valid.",
    );
    expect(describeIssue(firstIssue(z.object({ role: z.enum(["owner", "member"]) }), { role: "x" }))).toBe(
      "Role must be one of owner, member.",
    );
  });

  it("falls back when there's no issue or field", () => {
    expect(describeIssue(undefined)).toBe("Check the highlighted fields.");
    expect(describeIssue(firstIssue(z.string(), 1))).toBe("Check the highlighted fields.");
  });
});

describe("apiError", () => {
  it("maps statuses to plain sentences", async () => {
    const cases = [
      [apiError.unauthorized(), 401, "Sign in to continue."],
      [apiError.forbidden(), 403, "You don't have access to this."],
      [apiError.forbidden("project"), 403, "You don't have access to this project."],
      [apiError.notFound("app"), 404, "App not found."],
      [apiError.internal(), 500, "Something went wrong. Try again."],
    ] as const;
    for (const [res, status, error] of cases) {
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("includes field details on request", async () => {
    const r = z.object({ name: z.string() }).safeParse({});
    if (r.success) throw new Error("expected failure");
    const res = apiError.validation(r.error, { details: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Name is required.");
    expect(body.details.name).toHaveLength(1);
  });
});

describe("handleRouteError", () => {
  it("uses the same voice", async () => {
    expect(await handleRouteError(new Error("Unauthorized")).json()).toEqual({ error: "Sign in to continue." });
    expect(await handleRouteError(new Error("Forbidden")).json()).toEqual({ error: "You don't have access to this." });
    expect(await handleRouteError(new Error("boom")).json()).toEqual({ error: "Something went wrong. Try again." });
  });
});
