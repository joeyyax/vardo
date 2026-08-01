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
