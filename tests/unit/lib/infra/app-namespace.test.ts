import { describe, it, expect } from "vitest";

import {
  generateNamespace,
  isComposeSafe,
  resolveNamespace,
  slugifyForCompose,
} from "@/lib/infra/app-namespace";

describe("slugifyForCompose", () => {
  it("lowercases, since Compose rejects uppercase project names", () => {
    expect(slugifyForCompose("MyApp")).toBe("myapp");
  });

  it("collapses disallowed runs to a single dash", () => {
    expect(slugifyForCompose("my  weird//name")).toBe("my-weird-name");
  });

  it("trims leading and trailing separators", () => {
    expect(slugifyForCompose("--edge--")).toBe("edge");
    expect(slugifyForCompose("_edge_")).toBe("edge");
  });

  it("falls back rather than returning an empty stem", () => {
    expect(slugifyForCompose("///")).toBe("app");
    expect(slugifyForCompose("")).toBe("app");
  });

  it("keeps underscores, which Compose allows after the first character", () => {
    expect(slugifyForCompose("a_b")).toBe("a_b");
  });
});

describe("generateNamespace", () => {
  const zeros = () => 0;

  it("keeps the name as a readable stem", () => {
    expect(generateNamespace("tautulli", zeros)).toBe("tautulli-aaaaaaaa");
  });

  it("produces a compose-safe result for hostile names", () => {
    for (const name of ["MyApp", "  ", "///", "UPPER_CASE", "-leading", "trailing-", "a".repeat(200)]) {
      expect(isComposeSafe(generateNamespace(name))).toBe(true);
    }
  });

  it("distinguishes two apps sharing a name", () => {
    const a = generateNamespace("api");
    const b = generateNamespace("api");
    expect(a).not.toBe(b);
  });

  it("never emits an id-style uppercase suffix, which Compose would reject", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateNamespace("app")).toMatch(/^app-[a-z0-9]{8}$/);
    }
  });
});

describe("resolveNamespace", () => {
  it("prefers the namespace once an app has one", () => {
    expect(resolveNamespace({ name: "old-name", namespace: "new-ns-abcd1234" })).toBe("new-ns-abcd1234");
  });

  it("falls back to the name for apps that predate the column", () => {
    expect(resolveNamespace({ name: "legacy" })).toBe("legacy");
    expect(resolveNamespace({ name: "legacy", namespace: null })).toBe("legacy");
  });

  it("treats a blank namespace as absent rather than resolving to empty", () => {
    expect(resolveNamespace({ name: "legacy", namespace: "   " })).toBe("legacy");
  });

  it("is stable across a rename, which is the whole point", () => {
    const app = { name: "before", namespace: "before-9f2a1c7d" };
    const renamed = { ...app, name: "after" };
    expect(resolveNamespace(renamed)).toBe(resolveNamespace(app));
  });
});
