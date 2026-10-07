import { describe, expect, it } from "vitest";
import { isNavActive } from "@/lib/ui/nav-active";

describe("isNavActive", () => {
  it("matches the exact route", () => {
    expect(isNavActive("/settings/team", "/settings/team")).toBe(true);
  });

  it("matches nested routes", () => {
    expect(isNavActive("/settings/team/abc/edit", "/settings/team")).toBe(true);
  });

  it("does not match a sibling that shares a prefix", () => {
    expect(isNavActive("/settings/teams", "/settings/team")).toBe(false);
    expect(isNavActive("/admin/settings/backups", "/admin/settings/backup")).toBe(false);
  });

  it("does not match a parent", () => {
    expect(isNavActive("/settings", "/settings/team")).toBe(false);
  });
});
