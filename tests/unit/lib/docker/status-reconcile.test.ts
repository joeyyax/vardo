import { describe, it, expect } from "vitest";
import {
  deriveStatus,
  matchContainers,
  parseExitCode,
  type ReconcilableApp,
} from "@/lib/docker/status-reconcile";
import type { ContainerInfo } from "@/lib/docker/client";

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: "c1",
    name: "app-1",
    image: "img",
    state: "running",
    status: "Up 2 hours",
    ports: [],
    labels: {},
    ...over,
  };
}

function app(over: Partial<ReconcilableApp> = {}): ReconcilableApp {
  return {
    id: "app-id",
    name: "myapp",
    status: "active",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    ...over,
  };
}

describe("deriveStatus", () => {
  it("reports missing when the app has no containers at all", () => {
    expect(deriveStatus([])).toBe("missing");
  });

  it("reports active when any container is running", () => {
    expect(deriveStatus([container({ state: "exited" }), container({ state: "running" })])).toBe(
      "active",
    );
  });

  it("reports error while a container is restarting", () => {
    expect(deriveStatus([container({ state: "restarting" })])).toBe("error");
  });

  it("reports error for a non-zero exit", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (137) 3 days ago" })]),
    ).toBe("error");
  });

  it("reports stopped for a clean exit", () => {
    expect(deriveStatus([container({ state: "exited", status: "Exited (0) 3 days ago" })])).toBe(
      "stopped",
    );
  });
});

describe("parseExitCode", () => {
  it("reads the code out of a list-API status string", () => {
    expect(parseExitCode("Exited (137) 3 days ago")).toBe(137);
  });

  it("returns null for a running container", () => {
    expect(parseExitCode("Up 2 hours")).toBeNull();
  });
});

describe("matchContainers", () => {
  it("matches on the vardo app id label", () => {
    const c = container({ labels: { "vardo.project.id": "app-id" } });
    expect(matchContainers(app(), [c, container({ id: "other" })])).toEqual([c]);
  });

  it("matches the legacy host.* label prefix", () => {
    const c = container({ labels: { "host.project.id": "app-id" } });
    expect(matchContainers(app(), [c])).toEqual([c]);
  });

  it("narrows a decomposed child to its compose service", () => {
    const wanted = container({
      id: "svc",
      labels: { "vardo.project": "myapp", "com.docker.compose.service": "redis" },
    });
    const other = container({
      id: "svc2",
      labels: { "vardo.project": "myapp", "com.docker.compose.service": "postgres" },
    });
    const child = app({ composeService: "redis", name: "myapp" });
    expect(matchContainers(child, [wanted, other])).toEqual([wanted]);
  });

  it("falls back to the container name for unlabelled control-plane containers", () => {
    const c = container({ name: "vardo-postgres" });
    expect(matchContainers(app({ name: "vardo-postgres" }), [c])).toEqual([c]);
  });

  it("falls back to the compose project label", () => {
    const c = container({ name: "vardo-redis-1", labels: { "com.docker.compose.project": "vardo" } });
    expect(matchContainers(app({ name: "vardo" }), [c])).toEqual([c]);
  });

  it("returns nothing for a registered app whose containers are gone", () => {
    expect(matchContainers(app({ name: "cadvisor" }), [container()])).toEqual([]);
  });

  it("prefers the imported container id", () => {
    const c = container({ id: "imported-id", labels: {} });
    expect(matchContainers(app({ importedContainerId: "imported-id" }), [c, container()])).toEqual([
      c,
    ]);
  });
});

describe("matchContainers — blue/green decomposition", () => {
  const container = (over: Record<string, unknown> = {}) =>
    ({
      id: "c1",
      name: "paperless-production-green-paperless-1",
      state: "running",
      status: "Up 3 days",
      labels: {
        "com.docker.compose.project": "paperless-production-green",
        "com.docker.compose.service": "paperless",
        "vardo.project": "paperless",
        "vardo.project.id": "PARENT_ID",
      },
      ...over,
    }) as never;

  const child = {
    id: "CHILD_ID",
    name: "paperless-paperless",
    status: "active",
    parentAppId: "PARENT_ID",
    composeService: "paperless",
    containerName: null,
    importedContainerId: null,
  };

  it("matches a decomposed child via the parent's project.id plus service", () => {
    expect(matchContainers(child, [container()])).toHaveLength(1);
  });

  it("does not match a sibling service of the same parent", () => {
    expect(matchContainers({ ...child, composeService: "paperless-db" }, [container()])).toHaveLength(0);
  });

  it("matches a parent app by compose project minus the slot suffix", () => {
    const parent = { ...child, id: "PARENT_ID", name: "paperless", parentAppId: null, composeService: null };
    expect(matchContainers(parent, [container()])).toHaveLength(1);
  });

  it("still reports a genuinely absent service as unmatched", () => {
    const missing = { ...child, id: "X", name: "cadvisor", parentAppId: null, composeService: null };
    expect(matchContainers(missing, [container()])).toHaveLength(0);
  });

  // A shared service sits in `${app}-${env}-shared`, so the label-less fallback
  // has to strip that suffix the same way it strips blue/green.
  it("matches a parent app by the shared project name when the container carries no vardo labels", () => {
    const shared = container({
      name: "paperless-production-shared-db-1",
      labels: {
        "com.docker.compose.project": "paperless-production-shared",
        "com.docker.compose.service": "db",
      },
    });
    const parent = { ...child, id: "PARENT_ID", name: "paperless", parentAppId: null, composeService: null };
    expect(matchContainers(parent, [shared])).toHaveLength(1);
  });
});
