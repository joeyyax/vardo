// The proxy buffers request bodies up to 10 MB, so the import upload route must stay outside its matcher.

import { describe, it, expect, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/lib/auth/api-token", () => ({ findApiToken: vi.fn() }));

import { config } from "@/proxy";

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy matcher", () => {
  it("covers the API", () => {
    expect(matches("/api/v1/organizations/o/apps")).toBe(true);
    expect(matches("/api/v1/organizations/o/apps/a/backup-now")).toBe(true);
    expect(matches("/api/health")).toBe(true);
  });

  it("leaves out the app import route", () => {
    expect(matches("/api/v1/organizations/o/apps/a/import")).toBe(false);
  });

  it("only that route: deeper or look-alike paths still match", () => {
    expect(matches("/api/v1/organizations/o/apps/a/import/extra")).toBe(true);
    expect(matches("/api/v1/organizations/o/apps/a/imports")).toBe(true);
  });

  it("stays off pages", () => {
    expect(matches("/apps")).toBe(false);
  });
});
