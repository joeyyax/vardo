import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

import { regenerateAppRouteConfig } from "@/lib/traefik/generate-config";
import { db } from "@/lib/db";
import * as fsp from "fs/promises";

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// Minimal app record with one domain — enough to reach the mkdir/writeFile paths
const mockApp = {
  id: "app-123",
  name: "test-app",
  containerPort: 3000,
  domains: [
    {
      id: "dom-12345678",
      domain: "example.com",
      sslEnabled: false,
      certResolver: null,
      redirectTo: null,
      redirectCode: null,
    },
  ],
};

describe("regenerateAppRouteConfig — mkdir error handling", () => {
  beforeEach(() => {
    vi.mocked(db.query.apps.findFirst).mockResolvedValue(mockApp as never);
  });

  it("returns silently when mkdir fails with EACCES", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("EACCES"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("returns silently when mkdir fails with ENOENT", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("ENOENT"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("re-throws when mkdir fails with an unexpected error code", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow();
  });

  it("re-throws when mkdir fails with a plain Error (no code)", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(new Error("unexpected"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow("unexpected");
  });
});

describe("regenerateAppRouteConfig — writeFile/rename error handling", () => {
  beforeEach(() => {
    vi.mocked(db.query.apps.findFirst).mockResolvedValue(mockApp as never);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsp.rename).mockResolvedValue(undefined as never);
  });

  it("returns silently when writeFile fails with EACCES", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("EACCES"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("returns silently when writeFile fails with ENOENT", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("ENOENT"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("re-throws when writeFile fails with an unexpected error code", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow();
  });

  it("re-throws when rename fails with an unexpected error code", async () => {
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fsp.rename).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow();
  });
});
