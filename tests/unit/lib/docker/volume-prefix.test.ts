// `foo` + `pr-12` and `foo-pr` + `12` share one prefix (#894); the check must name the owner and skip the env being renamed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { limitMock, whereMock, appFindFirst } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  whereMock: vi.fn(),
  appFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (cond: unknown) => {
            whereMock(cond);
            return { limit: limitMock };
          },
        }),
      }),
    }),
    query: { apps: { findFirst: appFindFirst } },
  },
}));

import { volumePrefix, findPrefixOwner, findPrefixOwnerForApp } from "@/lib/docker/volume-prefix";

const sqlOf = (cond: unknown) => new PgDialect().sqlToQuery(cond as never);

beforeEach(() => vi.clearAllMocks());

describe("volumePrefix", () => {
  it("is ambiguous for hyphenated names, which is why creation checks it", () => {
    expect(volumePrefix("foo", "pr-12")).toBe(volumePrefix("foo-pr", "12"));
  });
});

describe("findPrefixOwner", () => {
  it("matches on the joined prefix", async () => {
    limitMock.mockResolvedValue([{ app: "foo", env: "pr-12" }]);

    expect(await findPrefixOwner("foo-pr", "12")).toBe("foo (pr-12)");
    expect(sqlOf(whereMock.mock.calls[0][0]).params).toContain("foo-pr-12");
  });

  it("returns null when the prefix is free", async () => {
    limitMock.mockResolvedValue([]);

    expect(await findPrefixOwner("foo", "staging")).toBeNull();
  });

  it("excludes the environment being renamed", async () => {
    limitMock.mockResolvedValue([]);

    await findPrefixOwner("foo", "staging", "env-1");

    expect(sqlOf(whereMock.mock.calls[0][0]).params).toContain("env-1");
  });
});

describe("findPrefixOwnerForApp", () => {
  it("looks the app name up first", async () => {
    appFindFirst.mockResolvedValue({ name: "foo-pr" });
    limitMock.mockResolvedValue([{ app: "foo", env: "pr-12" }]);

    expect(await findPrefixOwnerForApp("a2", "12")).toBe("foo (pr-12)");
  });

  it("is null for an unknown app", async () => {
    appFindFirst.mockResolvedValue(undefined);

    expect(await findPrefixOwnerForApp("gone", "12")).toBeNull();
  });
});
