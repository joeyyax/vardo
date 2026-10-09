import { describe, it, expect } from "vitest";
import {
  middlewareProblem,
  parseMiddlewares,
  partitionMiddlewares,
  serializeMiddlewares,
} from "@/lib/domains/middlewares";

describe("middlewareProblem", () => {
  it("lets every organization use cloudflare-only", () => {
    expect(middlewareProblem("cloudflare-only@file", false)).toBeNull();
    expect(middlewareProblem("cloudflare-only@file", true)).toBeNull();
  });

  it("limits untrusted organizations to Vardo's middlewares", () => {
    expect(middlewareProblem("authentik@docker", false)).toMatch(/isn't a middleware Vardo provides/);
    expect(middlewareProblem("cloudflare-only", false)).toMatch(/isn't a middleware Vardo provides/);
    expect(middlewareProblem("authentik@docker", true)).toBeNull();
  });

  it("refuses names that could break the label, and Traefik internals", () => {
    for (const bad of ["a,b", "a b", "a`b", "@file", "x@FILE", ""]) expect(middlewareProblem(bad, true)).not.toBeNull();
    expect(middlewareProblem("api@internal", true)).toMatch(/internal/);
  });
});

describe("stored form", () => {
  it("round-trips without duplicates", () => {
    expect(parseMiddlewares(" a@file, b@docker ,a@file,")).toEqual(["a@file", "b@docker"]);
    expect(serializeMiddlewares(["a@file", "a@file", "b@docker"])).toBe("a@file,b@docker");
    expect(serializeMiddlewares([])).toBeNull();
    expect(parseMiddlewares(null)).toEqual([]);
  });

  it("partitions by trust", () => {
    expect(partitionMiddlewares("cloudflare-only@file,auth@docker", false)).toEqual({
      allowed: ["cloudflare-only@file"],
      refused: ["auth@docker"],
    });
  });
});
