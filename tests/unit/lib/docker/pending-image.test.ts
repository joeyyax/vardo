import { describe, it, expect } from "vitest";
import { pendingImageChange } from "@/lib/docker/image-updates/pending";

// The compose pin and the image the last deploy ran are separate facts. This
// is the comparison the service card and the updates panel both render from.

describe("pendingImageChange", () => {
  it("reports the pinned tag when compose moved ahead of the deploy", () => {
    expect(
      pendingImageChange(
        "ghcr.io/goauthentik/server:latest",
        "ghcr.io/goauthentik/server:2025.2.4",
      ),
    ).toEqual({ tag: "2025.2.4", repo: null });
  });

  it("carries the repository when that changed too", () => {
    expect(pendingImageChange("nginx:1.27", "ghcr.io/nginx/nginx:1.27")).toEqual({
      tag: "1.27",
      repo: "ghcr.io/nginx/nginx",
    });
  });

  it("returns null when both sides agree", () => {
    expect(pendingImageChange("redis:7.4", "redis:7.4")).toBeNull();
  });

  it("treats an implicit tag as latest", () => {
    expect(pendingImageChange("redis", "redis:latest")).toBeNull();
  });

  it("normalizes the default registry rather than reporting a change", () => {
    expect(pendingImageChange("docker.io/library/redis:7.4", "redis:7.4")).toBeNull();
  });

  it("ignores a digest pin on the deployed side", () => {
    expect(pendingImageChange("redis:7.4@sha256:abc", "redis:7.4")).toBeNull();
  });

  it("returns null when the pin interpolates a variable", () => {
    expect(pendingImageChange("redis:7.4", "redis:${REDIS_TAG}")).toBeNull();
  });

  it("returns null when either side is missing", () => {
    expect(pendingImageChange(null, "redis:7.4")).toBeNull();
    expect(pendingImageChange("redis:7.4", null)).toBeNull();
    expect(pendingImageChange(undefined, undefined)).toBeNull();
  });
});
