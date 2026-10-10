import { describe, it, expect } from "vitest";
import { manageInVardoCopy, shapeAppDomains } from "@/lib/ui/app-domains";

type Row = Parameters<typeof shapeAppDomains>[0][number];

const row = (over: Partial<Row>): Row => ({
  id: "d1",
  domain: "app.example.com",
  pathPrefix: null,
  isPrimary: false,
  source: "vardo",
  composeRouter: null,
  ...over,
});

describe("shapeAppDomains", () => {
  it("marks compose rows read-only and lists them after managed ones", () => {
    const shaped = shapeAppDomains([
      row({ id: "c1", domain: "b.example.com", source: "compose", composeRouter: "site" }),
      row({ id: "m1", domain: "a.example.com" }),
      row({ id: "p1", domain: "p.example.com", isPrimary: true }),
    ]);
    expect(shaped.map((d) => [d.id, d.readOnly])).toEqual([["p1", false], ["m1", false], ["c1", true]]);
  });

  it("shows one row when a label and a managed domain claim the same host, managed winning", () => {
    const shaped = shapeAppDomains([
      row({ id: "c1", source: "compose", composeRouter: "site" }),
      row({ id: "m1" }),
    ]);
    expect(shaped).toHaveLength(1);
    expect(shaped[0]).toMatchObject({ id: "m1", readOnly: false, redundantRouter: "site" });
  });

  it("carries the redundant router stored on the managed row", () => {
    expect(shapeAppDomains([row({ composeRouter: "old" })])[0].redundantRouter).toBe("old");
  });

  it("treats rows without a source as managed", () => {
    const shaped = shapeAppDomains([row({ source: undefined })]);
    expect(shaped[0]).toMatchObject({ readOnly: false, redundantRouter: null });
  });

  it("keeps different paths on one host apart", () => {
    expect(shapeAppDomains([row({}), row({ id: "c1", source: "compose", pathPrefix: "/api" })])).toHaveLength(2);
  });
});

describe("manageInVardoCopy", () => {
  it("tells the user to remove the label", () => {
    const copy = manageInVardoCopy({ domain: "app.example.com", pathPrefix: "/api", composeRouter: "site" }, 0);
    expect(copy).toContain("app.example.com/api");
    expect(copy).toContain('router "site"');
    expect(copy).toContain("won't change your repository");
  });

  it("warns when other compose domains would stop routing", () => {
    expect(manageInVardoCopy({ domain: "app.example.com" }, 2)).toContain("2 compose domains");
  });
});
