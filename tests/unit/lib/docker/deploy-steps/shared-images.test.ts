// ---------------------------------------------------------------------------
// Which shared images a deploy has to fetch, and which running shared services
// no longer match the compose file.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

import {
  driftedFromDryRun,
  sharedContainerNames,
  sharedPullTargets,
} from "@/lib/docker/deploy-steps/shared-images";
import type { ComposeService } from "@/lib/docker/compose-types";

const shared = (services: Record<string, Partial<ComposeService>>) =>
  services as Record<string, ComposeService>;

describe("sharedPullTargets", () => {
  it("names a service whose image is missing from the host", async () => {
    const isLocal = vi.fn(async () => false);

    expect(
      await sharedPullTargets(shared({ traefik: { image: "traefik:v3.2" } }), [], isLocal),
    ).toEqual(["traefik"]);
    expect(isLocal).toHaveBeenCalledWith("traefik:v3.2");
  });

  it("skips a tag already on the host — the up will not replace the container anyway", async () => {
    expect(
      await sharedPullTargets(
        shared({ traefik: { image: "traefik:v3.2" } }),
        [],
        async () => true,
      ),
    ).toEqual([]);
  });

  it("skips a digest pin already on the host, which cannot be stale", async () => {
    expect(
      await sharedPullTargets(
        shared({ postgres: { image: "postgres@sha256:abc" } }),
        [],
        async () => true,
      ),
    ).toEqual([]);
  });

  it("pulls a digest pin the host does not hold", async () => {
    expect(
      await sharedPullTargets(
        shared({ postgres: { image: "postgres@sha256:abc" } }),
        [],
        async () => false,
      ),
    ).toEqual(["postgres"]);
  });

  it("leaves a service this deploy built locally alone", async () => {
    expect(
      await sharedPullTargets(
        shared({ app: { image: "host/app:sha" } }),
        ["host/app:sha"],
        async () => false,
      ),
    ).toEqual([]);
  });

  it("leaves a service compose builds alone", async () => {
    expect(
      await sharedPullTargets(
        shared({ app: { image: "host/app:1", build: "." as unknown as ComposeService["build"] } }),
        [],
        async () => false,
      ),
    ).toEqual([]);
  });
});

describe("sharedContainerNames", () => {
  it("uses container_name when the service pins one", () => {
    const names = sharedContainerNames(
      shared({ traefik: { image: "traefik:v3.2", container_name: "vardo-traefik" } }),
      "vardo",
    );
    expect(names.get("vardo-traefik")).toBe("traefik");
  });

  it("falls back to the name compose generates", () => {
    const names = sharedContainerNames(shared({ postgres: { image: "postgres:17" } }), "app-production-shared");
    expect(names.get("app-production-shared-postgres-1")).toBe("postgres");
  });
});

describe("driftedFromDryRun", () => {
  const containers = new Map([["vardo-traefik", "traefik"], ["vardo-redis", "redis"]]);

  it("reads the service compose would replace", () => {
    const output = " Container vardo-traefik  Recreate \n Container vardo-redis  Running ";
    expect(driftedFromDryRun(output, containers)).toEqual(["traefik"]);
  });

  it("says nothing when every container matches its definition", () => {
    expect(driftedFromDryRun(" Container vardo-traefik  Running ", containers)).toEqual([]);
  });

  it("ignores a container that does not exist yet", () => {
    expect(driftedFromDryRun(" Container vardo-traefik  Creating ", containers)).toEqual([]);
  });

  it("ignores containers outside the shared set", () => {
    expect(driftedFromDryRun(" Container other-thing  Recreate ", containers)).toEqual([]);
  });

  it("reports each service once", () => {
    const output = " Container vardo-traefik  Recreate \n Container vardo-traefik  Recreate ";
    expect(driftedFromDryRun(output, containers)).toEqual(["traefik"]);
  });
});
