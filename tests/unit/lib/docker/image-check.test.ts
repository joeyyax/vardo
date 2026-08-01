import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ apps: {}, imageUpdateChecks: {} }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn().mockResolvedValue(null),
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/client", () => ({ inspectImageDigest: vi.fn() }));
vi.mock("@/lib/docker/image-updates/registry", () => ({
  fetchRemoteDigest: vi.fn(),
  fetchTags: vi.fn(),
  RateLimitedError: class RateLimitedError extends Error {},
}));

import { checkImage } from "@/lib/docker/image-updates/check";
import { parseImageRef } from "@/lib/docker/image-updates/image-ref";
import { inspectImageDigest } from "@/lib/docker/client";
import { fetchRemoteDigest, fetchTags } from "@/lib/docker/image-updates/registry";

const remoteDigest = vi.mocked(fetchRemoteDigest);
const tags = vi.mocked(fetchTags);
const localDigest = vi.mocked(inspectImageDigest);

function ref(image: string) {
  return parseImageRef(image)!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkImage — floating tags", () => {
  it("compares digests and reports drift when they differ", async () => {
    remoteDigest.mockResolvedValue("sha256:bbb");
    localDigest.mockResolvedValue("gitea/gitea@sha256:aaa");

    const result = await checkImage(ref("gitea/gitea:latest"), "gitea/gitea:latest");
    expect(result.status).toBe("drift");
    expect(tags).not.toHaveBeenCalled();
  });

  it("reports current when the digests match", async () => {
    remoteDigest.mockResolvedValue("sha256:aaa");
    localDigest.mockResolvedValue("gitea/gitea@sha256:aaa");

    const result = await checkImage(ref("gitea/gitea:latest"), "gitea/gitea:latest");
    expect(result.status).toBe("current");
  });

  it("says unknown, never current, when there is no local digest", async () => {
    remoteDigest.mockResolvedValue("sha256:aaa");
    localDigest.mockResolvedValue(null);

    const result = await checkImage(ref("nginx:latest"), "nginx:latest");
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/local digest/i);
  });

  it("says unknown when the tag is missing from the registry", async () => {
    remoteDigest.mockResolvedValue(null);

    const result = await checkImage(ref("nginx:latest"), "nginx:latest");
    expect(result.status).toBe("unknown");
  });

  it("takes the digest path for a LinuxServer short form", async () => {
    remoteDigest.mockResolvedValue("sha256:aaa");
    localDigest.mockResolvedValue("sha256:aaa");

    const image = "lscr.io/linuxserver/plex:4.0.17";
    const result = await checkImage(ref(image), image);
    expect(result.status).toBe("current");
    expect(tags).not.toHaveBeenCalled();
  });
});

describe("checkImage — pinned tags", () => {
  it("enumerates tags and proposes the newest", async () => {
    tags.mockResolvedValue(["1.26.1", "1.26.2", "1.26.3", "1.27.0", "latest"]);

    const result = await checkImage(ref("gitea/gitea:1.26.2"), "gitea/gitea:1.26.2");
    expect(result).toMatchObject({ status: "update", latestTag: "1.27.0", severity: "minor" });
    expect(remoteDigest).not.toHaveBeenCalled();
  });

  it("reports current when nothing is newer", async () => {
    tags.mockResolvedValue(["1.26.1", "1.26.2", "latest"]);

    const result = await checkImage(ref("gitea/gitea:1.26.2"), "gitea/gitea:1.26.2");
    expect(result.status).toBe("current");
    expect(result.latestTag).toBeNull();
  });

  it("uses the ls build counter for LinuxServer pins", async () => {
    tags.mockResolvedValue(["4.0.17.2952-ls314", "4.0.17.2952-ls315", "latest"]);

    const image = "lscr.io/linuxserver/plex:4.0.17.2952-ls314";
    const result = await checkImage(ref(image), image);
    expect(result).toMatchObject({ status: "update", latestTag: "4.0.17.2952-ls315" });
  });

  it("refuses an unrecognized tag scheme instead of calling it current", async () => {
    const result = await checkImage(ref("owner/app:a29cda858"), "owner/app:a29cda858");
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Unrecognized tag scheme/);
    expect(tags).not.toHaveBeenCalled();
  });

  it("says unknown when the registry returns no tags", async () => {
    tags.mockResolvedValue([]);

    const result = await checkImage(ref("gitea/gitea:1.26.2"), "gitea/gitea:1.26.2");
    expect(result.status).toBe("unknown");
  });

  it("surfaces same-family tags it could not order", async () => {
    tags.mockResolvedValue(["2026.6.13-b1234567", "2026.6.20-c7654321"]);

    const image = "owner/app:2026.6.13-a29cda858";
    const result = await checkImage(ref(image), image);
    expect(result.latestTag).toBe("2026.6.20-c7654321");
    expect(result.unorderable).toContain("2026.6.13-b1234567");
  });
});
