import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      externalRoutes: {
        findMany: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/system-settings", () => ({
  getSslConfig: vi.fn(),
  getPrimaryIssuer: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

import { regenerateExternalRoutesConfig } from "@/lib/traefik/generate-external-routes-config";
import { db } from "@/lib/db";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import * as fsp from "fs/promises";

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// Minimal route record — enough to reach the mkdir/writeFile paths
const mockRoutes = [
  {
    id: "route-123",
    hostname: "proxy.example.com",
    targetUrl: "http://10.0.0.1:8080",
    redirectUrl: null,
    redirectPermanent: false,
    tls: false,
    insecureSkipVerify: false,
  },
];

describe("regenerateExternalRoutesConfig — mkdir error handling", () => {
  beforeEach(() => {
    vi.mocked(db.query.externalRoutes.findMany).mockResolvedValue(mockRoutes as never);
    vi.mocked(getSslConfig).mockResolvedValue({ activeIssuers: ["le"] } as never);
    vi.mocked(getPrimaryIssuer).mockReturnValue("le" as never);
  });

  it("returns silently when mkdir fails with EACCES", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("EACCES"));
    await expect(regenerateExternalRoutesConfig()).resolves.toBeUndefined();
  });

  it("returns silently when mkdir fails with ENOENT", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("ENOENT"));
    await expect(regenerateExternalRoutesConfig()).resolves.toBeUndefined();
  });

  it("re-throws when mkdir fails with an unexpected error code", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateExternalRoutesConfig()).rejects.toThrow();
  });

  it("re-throws when mkdir fails with a plain Error (no code)", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(new Error("unexpected"));
    await expect(regenerateExternalRoutesConfig()).rejects.toThrow("unexpected");
  });
});

describe("regenerateExternalRoutesConfig — writeFile/rename error handling", () => {
  beforeEach(() => {
    vi.mocked(db.query.externalRoutes.findMany).mockResolvedValue(mockRoutes as never);
    vi.mocked(getSslConfig).mockResolvedValue({ activeIssuers: ["le"] } as never);
    vi.mocked(getPrimaryIssuer).mockReturnValue("le" as never);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsp.rename).mockResolvedValue(undefined as never);
  });

  it("returns silently when writeFile fails with EACCES", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("EACCES"));
    await expect(regenerateExternalRoutesConfig()).resolves.toBeUndefined();
  });

  it("returns silently when writeFile fails with ENOENT", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("ENOENT"));
    await expect(regenerateExternalRoutesConfig()).resolves.toBeUndefined();
  });

  it("re-throws when writeFile fails with an unexpected error code", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateExternalRoutesConfig()).rejects.toThrow();
  });

  it("re-throws when rename fails with an unexpected error code", async () => {
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fsp.rename).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateExternalRoutesConfig()).rejects.toThrow();
  });
});
