import { describe, it, expect } from "vitest";
import { classifyComposeServices } from "@/lib/docker/deploy-steps/classify-services";
import type { ComposeFile } from "@/lib/docker/compose-types";

// ---------------------------------------------------------------------------
// classifyComposeServices — swap build/pull split
// ---------------------------------------------------------------------------
// Regression for the bug where a Dockerfile/Nixpacks-only repo (deployType
// "compose" with no compose file) was pre-built into host/<app>:<sha> and
// referenced via image: with no build: directive. The swap pre-pull then tried
// to `docker compose pull` the locally-built image and 404'd.

function services(map: Record<string, { image?: string; build?: unknown }>): ComposeFile["services"] {
  return map as unknown as ComposeFile["services"];
}

describe("classifyComposeServices", () => {
  it("pulls a registry image with no build directive", () => {
    const { buildServices, pullServices } = classifyComposeServices(
      services({ db: { image: "postgres:16" } }),
    );
    expect(buildServices).toEqual([]);
    expect(pullServices).toEqual(["db"]);
  });

  it("builds a service with a build directive (never pulls it)", () => {
    const { buildServices, pullServices } = classifyComposeServices(
      services({ app: { build: { context: "." }, image: "host/app:abc" } }),
    );
    expect(buildServices).toEqual(["app"]);
    expect(pullServices).toEqual([]);
  });

  it("excludes a locally-built image from the pull set", () => {
    const built = "host/app:abc1234";
    const { buildServices, pullServices } = classifyComposeServices(
      services({ app: { image: built } }),
      [built],
    );
    // No build: directive, but it was built locally — so neither build nor pull.
    expect(buildServices).toEqual([]);
    expect(pullServices).toEqual([]);
  });

  it("pulls registry sidecars while skipping the locally-built app image", () => {
    const built = "host/app:abc1234";
    const { buildServices, pullServices } = classifyComposeServices(
      services({
        app: { image: built },
        db: { image: "postgres:16" },
        cache: { image: "redis:7" },
      }),
      [built],
    );
    expect(buildServices).toEqual([]);
    expect(pullServices).toEqual(["db", "cache"]);
  });

  it("still pulls a registry image even if an unrelated ref was built locally", () => {
    const { pullServices } = classifyComposeServices(
      services({ db: { image: "postgres:16" } }),
      ["host/other-app:deadbeef"],
    );
    expect(pullServices).toEqual(["db"]);
  });
});
