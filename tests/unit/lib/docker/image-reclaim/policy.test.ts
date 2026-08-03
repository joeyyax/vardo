import { describe, expect, it } from "vitest";

import {
  DEFAULT_IDLE_DAYS,
  classifyImage,
  composeBuilds,
  idleDays,
  imageReclaimable,
  imageSkipReason,
  isVersionPinnedTag,
  resolveIdleThreshold,
} from "@/lib/docker/image-reclaim/policy";
import { parseImageRef } from "@/lib/docker/image-updates/image-ref";

function classify(image: string) {
  const ref = parseImageRef(image);
  if (!ref) throw new Error(`unparsable: ${image}`);
  return classifyImage(ref);
}

describe("isVersionPinnedTag", () => {
  it("accepts tags naming at least a major and minor", () => {
    for (const tag of ["1.8.1", "v3.6", "8.0.45-1.el9", "2.20.15", "0.0.3", "12.8.1-base-ubuntu24.04"]) {
      expect(isVersionPinnedTag(tag), tag).toBe(true);
    }
  });

  it("rejects tags that move", () => {
    for (const tag of ["latest", "stable", "main", "edge", "alpine", "16", "v3", "7-alpine", "nvidia", "release-cuda"]) {
      expect(isVersionPinnedTag(tag), tag).toBe(false);
    }
  });
});

describe("classifyImage", () => {
  it("treats digest pins as pinned regardless of engine", () => {
    expect(classify("postgres@sha256:abc")).toBe("pinned");
    expect(classify("jellyfin/jellyfin@sha256:abc")).toBe("pinned");
  });

  it("treats a versioned tag on an ordinary image as pinned", () => {
    expect(classify("ghcr.io/paperless-ngx/paperless-ngx:2.20.15")).toBe("pinned");
    expect(classify("traefik:v3.6")).toBe("pinned");
  });

  it("treats a floating tag on an ordinary image as floating", () => {
    expect(classify("jellyfin/jellyfin:latest")).toBe("floating");
    expect(classify("ghcr.io/open-webui/open-webui:main")).toBe("floating");
    expect(classify("gotenberg/gotenberg:8")).toBe("floating");
  });

  it("requires a digest for major-locked engines, however specific the tag", () => {
    // mysql:8.0 still moves within 8.0.x, and these images refuse to start
    // against a data directory written by another major.
    expect(classify("mysql:8.0")).toBe("stateful-unpinned");
    expect(classify("postgres:16")).toBe("stateful-unpinned");
    expect(classify("postgres:17-alpine")).toBe("stateful-unpinned");
    expect(classify("postgres:latest")).toBe("stateful-unpinned");
    expect(classify("mongo:7.0")).toBe("stateful-unpinned");
    expect(classify("tensorchord/pgvecto-rs:pg16-v0.2.0")).toBe("stateful-unpinned");
  });

  it("does not treat redis as stateful — its data is forward compatible", () => {
    expect(classify("redis:8.10.0-alpine3.23")).toBe("pinned");
    expect(classify("redis:alpine")).toBe("floating");
  });
});

describe("imageReclaimable", () => {
  it("allows pinned images under any policy", () => {
    expect(imageReclaimable("pinned", "auto")).toBe(true);
    expect(imageReclaimable("pinned", "always")).toBe(true);
  });

  it("allows floating images only with an explicit opt-in", () => {
    expect(imageReclaimable("floating", "auto")).toBe(false);
    expect(imageReclaimable("floating", "always")).toBe(true);
  });

  it("never allows an unpinned stateful image, even when opted in", () => {
    expect(imageReclaimable("stateful-unpinned", "auto")).toBe(false);
    expect(imageReclaimable("stateful-unpinned", "always")).toBe(false);
    expect(imageReclaimable("stateful-unpinned", "never")).toBe(false);
  });

  it("reports the reason that matches the safety class", () => {
    expect(imageSkipReason("stateful-unpinned")).toBe("stateful-floating");
    expect(imageSkipReason("floating")).toBe("floating-tag");
  });
});

describe("idleDays", () => {
  const now = new Date("2026-08-02T00:00:00Z");

  it("returns null when the app has never been observed running", () => {
    expect(idleDays(null, now)).toBeNull();
  });

  it("floors to whole days", () => {
    expect(idleDays(new Date("2026-07-03T12:00:00Z"), now)).toBe(29);
    expect(idleDays(new Date("2026-07-03T00:00:00Z"), now)).toBe(30);
  });

  it("clamps clock skew to zero rather than going negative", () => {
    expect(idleDays(new Date("2026-08-03T00:00:00Z"), now)).toBe(0);
  });
});

describe("resolveIdleThreshold", () => {
  it("prefers the per-app override", () => {
    expect(resolveIdleThreshold(7, DEFAULT_IDLE_DAYS)).toBe(7);
  });

  it("falls back to the instance default", () => {
    expect(resolveIdleThreshold(null, 45)).toBe(45);
    expect(resolveIdleThreshold(undefined, 45)).toBe(45);
  });

  it("clamps out-of-range values", () => {
    expect(resolveIdleThreshold(0, 30)).toBe(1);
    expect(resolveIdleThreshold(-5, 30)).toBe(1);
    expect(resolveIdleThreshold(99999, 30)).toBe(3650);
  });
});

describe("composeBuilds", () => {
  it("detects a build directive", () => {
    expect(
      composeBuilds(["services:", "  frontend:", "    build:", "      context: ."].join("\n")),
    ).toBe(true);
  });

  it("does not fire on an image-only compose", () => {
    expect(composeBuilds(["services:", "  web:", "    image: nginx:1.27"].join("\n"))).toBe(false);
  });

  it("does not fire on the word build inside a value", () => {
    expect(composeBuilds(["services:", "  web:", "    image: acme/build:1.2"].join("\n"))).toBe(false);
  });
});
