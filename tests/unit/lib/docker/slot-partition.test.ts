import { describe, expect, it } from "vitest";
import {
  SHARED_MARKER,
  SlotPartitionError,
  composeSubset,
  hasSharedServices,
  isSharedService,
  partitionBySlot,
  slotScopeArgs,
} from "@/lib/docker/slot-partition";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";

function file(services: Record<string, Partial<ComposeService>>): ComposeFile {
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, svc]) => [name, { name, ...svc } as ComposeService]),
    ),
    networks: { "vardo-network": { external: true } },
  };
}

describe("partitionBySlot", () => {
  it("leaves an app with no marked services entirely slotted", () => {
    const { shared, slotted } = partitionBySlot(file({ web: {}, worker: {} }));
    expect(Object.keys(shared)).toEqual([]);
    expect(Object.keys(slotted)).toEqual(["web", "worker"]);
  });

  it("splits the marked services out", () => {
    const { shared, slotted } = partitionBySlot(
      file({ web: {}, postgres: { [SHARED_MARKER]: true }, redis: { [SHARED_MARKER]: true } }),
    );
    expect(Object.keys(shared)).toEqual(["postgres", "redis"]);
    expect(Object.keys(slotted)).toEqual(["web"]);
  });

  it("drops a slotted service's dependency on a shared one, since projects differ", () => {
    const { slotted } = partitionBySlot(
      file({
        web: { depends_on: ["postgres", "worker"] },
        worker: {},
        postgres: { [SHARED_MARKER]: true },
      }),
    );
    expect(slotted.web.depends_on).toEqual(["worker"]);
  });

  it("drops the same dependency in the condition form", () => {
    const { slotted } = partitionBySlot(
      file({
        web: {
          depends_on: {
            postgres: { condition: "service_healthy" },
            worker: { condition: "service_started" },
          },
        },
        worker: {},
        postgres: { [SHARED_MARKER]: true },
      }),
    );
    expect(slotted.web.depends_on).toEqual({ worker: { condition: "service_started" } });
  });

  it("removes depends_on entirely when nothing survives the split", () => {
    const { slotted } = partitionBySlot(
      file({ web: { depends_on: ["postgres"] }, postgres: { [SHARED_MARKER]: true } }),
    );
    expect(slotted.web.depends_on).toBeUndefined();
  });

  it("does not mutate the compose file it was handed", () => {
    const source = file({ web: { depends_on: ["postgres"] }, postgres: { [SHARED_MARKER]: true } });
    partitionBySlot(source);
    expect(source.services.web.depends_on).toEqual(["postgres"]);
  });

  it("rejects a shared service that depends on one being replaced", () => {
    expect(() =>
      partitionBySlot(
        file({ web: {}, postgres: { [SHARED_MARKER]: true, depends_on: ["web"] } }),
      ),
    ).toThrow(SlotPartitionError);
  });

  it("rejects marking every service, which would leave nothing to deploy", () => {
    expect(() =>
      partitionBySlot(file({ web: { [SHARED_MARKER]: true }, db: { [SHARED_MARKER]: true } })),
    ).toThrow(/nothing left to deploy/);
  });

  it("allows a shared service to depend on another shared service", () => {
    const { shared } = partitionBySlot(
      file({
        web: {},
        postgres: { [SHARED_MARKER]: true },
        pgbouncer: { [SHARED_MARKER]: true, depends_on: ["postgres"] },
      }),
    );
    expect(shared.pgbouncer.depends_on).toEqual(["postgres"]);
  });
});

describe("isSharedService", () => {
  it("only treats an explicit true as the marker", () => {
    expect(isSharedService({ name: "a", [SHARED_MARKER]: true } as ComposeService)).toBe(true);
    expect(isSharedService({ name: "a" } as ComposeService)).toBe(false);
    expect(isSharedService(undefined)).toBe(false);
  });
});

describe("composeSubset", () => {
  it("keeps networks and volumes so each project can still resolve them", () => {
    const source = file({ web: {}, db: { [SHARED_MARKER]: true } });
    source.volumes = { data: {} };
    const { shared } = partitionBySlot(source);
    const subset = composeSubset(source, shared);
    expect(Object.keys(subset.services)).toEqual(["db"]);
    expect(subset.networks).toEqual(source.networks);
    expect(subset.volumes).toEqual(source.volumes);
  });
});

describe("hasSharedServices", () => {
  it("answers whether the two-project deploy is needed at all", () => {
    expect(hasSharedServices(file({ web: {} }))).toBe(false);
    expect(hasSharedServices(file({ web: {}, db: { [SHARED_MARKER]: true } }))).toBe(true);
  });
});

describe("slotScopeArgs", () => {
  it("adds nothing for an app with no shared services, keeping today's commands", () => {
    expect(slotScopeArgs(partitionBySlot(file({ web: {}, worker: {} })))).toEqual([]);
  });

  it("names the rotating services and disables dependency startup", () => {
    const partition = partitionBySlot(
      file({ web: {}, worker: {}, postgres: { [SHARED_MARKER]: true } }),
    );
    expect(slotScopeArgs(partition)).toEqual(["--no-deps", "web", "worker"]);
  });

  it("never names a shared service, which belongs to the other project", () => {
    const partition = partitionBySlot(file({ web: {}, postgres: { [SHARED_MARKER]: true } }));
    expect(slotScopeArgs(partition)).not.toContain("postgres");
  });
});
