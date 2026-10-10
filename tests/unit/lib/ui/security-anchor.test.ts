import { describe, it, expect } from "vitest";
import { findingAnchors, findingId } from "@/lib/ui/security-anchor";
import { securityHref } from "@/lib/ui/hrefs";

describe("findingId", () => {
  it("slugs the type and title", () => {
    expect(findingId({ type: "exposed-file", title: "/.env is publicly readable" })).toBe("exposed-file-env-is-publicly-readable");
  });

  it("is stable across scans of the same finding", () => {
    const a = findingId({ type: "port", title: "Port 5432 open" });
    expect(findingId({ type: "port", title: "Port 5432 open" })).toBe(a);
  });

  it("never returns an empty id", () => {
    expect(findingId({ type: "", title: "!!!" })).toBe("finding");
  });
});

describe("findingAnchors", () => {
  it("suffixes repeats so every element id is unique", () => {
    const f = { type: "port", title: "Port 80 open" };
    expect(findingAnchors([f, f])).toEqual(["finding-port-port-80-open", "finding-port-port-80-open-2"]);
  });

  it("matches the link the security tab is opened with", () => {
    const [anchor] = findingAnchors([{ type: "port", title: "Port 80 open" }]);
    expect(securityHref("web", findingId({ type: "port", title: "Port 80 open" }))).toBe(`/apps/web/security#${anchor}`);
  });
});
