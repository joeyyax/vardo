// ---------------------------------------------------------------------------
// The hold pins an app to its running old slot while the new slot warms up,
// built from the old slot's live labels, plain (pre-#904) or slot-suffixed.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import YAML from "yaml";

const { fsMock, apiMock } = vi.hoisted(() => ({
  fsMock: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  },
  apiMock: {
    liveContainers: vi.fn(),
    fetchTraefikRouters: vi.fn(),
    fetchTraefikServices: vi.fn(async () => []),
    collectDockerBackends: vi.fn(() => []),
  },
}));

vi.mock("fs/promises", () => ({ ...fsMock, default: fsMock }));
vi.mock("@/lib/docker/traefik-api", () => apiMock);
vi.mock("@/lib/paths", () => ({ TRAEFIK_DYNAMIC_DIR: "/traefik/dynamic" }));

import { guardCutover, holdSlot, pinIsLive, planCutover, PIN_CONFIRM_TIMEOUT } from "@/lib/docker/traefik-cutover";
import { slotTraefikNames } from "@/lib/docker/traefik-slot-names";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";

const OLD = "notes-api-production-green";
const PIN = "/traefik/dynamic/cutover-notes-api-production.yml";
const RULE = "Host(`notes.example.com`)";

/** The old slot's labels as deployed before #904: the router names no service. */
const PLAIN: Record<string, string> = {
  "traefik.enable": "true",
  "traefik.docker.network": "vardo-network",
  "traefik.http.routers.notes.entrypoints": "websecure",
  "traefik.http.routers.notes.rule": RULE,
  "traefik.http.routers.notes.tls.certresolver": "le-dns",
  "traefik.http.services.notes.loadbalancer.server.port": "3000",
};

const slotted: Record<string, ComposeService> = {
  "notes-api": { name: "notes-api", labels: PLAIN },
};

/** The same labels as a slot-suffixed deploy writes them. */
function suffixed(slot: string, labels: Record<string, string> = PLAIN): Record<string, string> {
  const file = { services: { "notes-api": { name: "notes-api", labels } } } as unknown as ComposeFile;
  return slotTraefikNames(file, slot).services["notes-api"].labels!;
}

function holdPlan(labels: Record<string, string>) {
  return planCutover({ services: {} } as unknown as ComposeFile, {
    newProjectName: OLD,
    slotted,
    liveLabels: { "notes-api": labels },
    suffix: "hold",
  });
}

function parse(yaml: string) {
  return YAML.parse(yaml) as {
    http: {
      routers: Record<string, { rule: string; service: string; priority: number; middlewares?: string[]; tls?: unknown }>;
      services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
    };
  };
}

function container(project: string, labels: Record<string, string>) {
  return {
    name: `${project}-notes-api-1`,
    ips: ["172.18.0.9"],
    labels: { ...labels, "com.docker.compose.project": project, "com.docker.compose.service": "notes-api" },
  };
}

describe("hold plan from the old slot's live labels", () => {
  it("holds a plain old slot whose router names no service", () => {
    const plan = holdPlan(PLAIN);
    const config = parse(plan!.yaml);

    expect(plan!.routerNames).toEqual(["notes-hold"]);
    expect(config.http.routers["notes-hold"]).toMatchObject({
      rule: RULE,
      service: "notes-hold",
      priority: RULE.length + 1,
      tls: { certResolver: "le-dns" },
    });
    expect(config.http.services["notes-hold"].loadBalancer.servers).toEqual([
      { url: `http://${OLD}-notes-api-1:3000` },
    ]);
  });

  it("holds a slot-suffixed old slot on its own router", () => {
    const plan = holdPlan(suffixed("green"));
    const config = parse(plan!.yaml);

    expect(plan!.routerNames).toEqual(["notes-green-hold"]);
    expect(config.http.routers["notes-green-hold"].service).toBe("notes-green-hold");
    expect(config.http.services["notes-green-hold"].loadBalancer.servers).toEqual([
      { url: `http://${OLD}-notes-api-1:3000` },
    ]);
  });

  it("references the old slot's own middlewares", () => {
    const labels = {
      ...PLAIN,
      "traefik.http.routers.notes.middlewares": "auth",
      "traefik.http.middlewares.auth.basicauth.users": "u:p",
    };
    expect(parse(holdPlan(labels)!.yaml).http.routers["notes-hold"].middlewares).toEqual(["auth@docker"]);
    expect(parse(holdPlan(suffixed("green", labels))!.yaml).http.routers["notes-green-hold"].middlewares).toEqual([
      "auth-green@docker",
    ]);
  });

  it("never shares router names with the cutover pin that replaces it", () => {
    const hold = holdPlan(suffixed("green"))!;
    const cutover = planCutover({ services: {} } as unknown as ComposeFile, {
      newProjectName: "notes-api-production-blue",
      slotted,
      liveLabels: { "notes-api": suffixed("blue") },
    })!;

    expect(cutover.routerNames).toEqual(["notes-blue-cutover"]);
    const holdLive = hold.routerNames.map((name) => ({ name: `${name}@file`, status: "enabled" }));
    expect(pinIsLive(holdLive, cutover.routerNames)).toBe(false);
  });

  it("skips a router without a service when the container declares two", () => {
    const labels = { ...PLAIN, "traefik.http.services.other.loadbalancer.server.port": "4000" };
    expect(holdPlan(labels)).toBeNull();
  });
});

describe("holdSlot", () => {
  const log = vi.fn();
  const hold = () =>
    holdSlot({ appName: "notes-api", envName: "production", slotted, projectName: OLD, log });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiMock.liveContainers.mockResolvedValue([container(OLD, PLAIN)]);
    apiMock.fetchTraefikRouters.mockResolvedValue([{ name: "notes-hold@file", status: "enabled" }]);
  });

  it("writes the pin atomically and confirms Traefik serves it", async () => {
    const result = await hold();

    expect(result.held).toBe(true);
    expect(fsMock.writeFile).toHaveBeenCalledWith(`${PIN}.tmp`, expect.stringContaining("notes-hold"), "utf-8");
    expect(fsMock.rename).toHaveBeenCalledWith(`${PIN}.tmp`, PIN);
    expect(fsMock.unlink).not.toHaveBeenCalled();

    await result.release();
    expect(fsMock.unlink).toHaveBeenCalledWith(PIN);
  });

  it("holds nothing when the old slot isn't running", async () => {
    apiMock.liveContainers.mockResolvedValue([container("other-project", PLAIN)]);
    const result = await hold();

    expect(result.held).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("goes on unheld without a Traefik volume", async () => {
    fsMock.mkdir.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const result = await hold();

    expect(result.held).toBe(false);
    expect(apiMock.fetchTraefikRouters).not.toHaveBeenCalled();
  });

  it("removes a pin it couldn't finish writing", async () => {
    fsMock.rename.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
    const result = await hold();

    expect(result.held).toBe(false);
    expect(fsMock.unlink).toHaveBeenCalledWith(PIN);
  });

  it("removes the pin when Traefik never reports it live", async () => {
    vi.useFakeTimers();
    apiMock.fetchTraefikRouters.mockResolvedValue(null);
    const pending = hold();
    await vi.advanceTimersByTimeAsync(PIN_CONFIRM_TIMEOUT + 1_000);
    const result = await pending;

    expect(result.held).toBe(false);
    expect(fsMock.unlink).toHaveBeenCalledWith(PIN);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("starting the new slot unheld"));
  });
});

describe("guardCutover over a hold", () => {
  it("removes the hold when the cutover pin can't be written", async () => {
    vi.clearAllMocks();
    apiMock.liveContainers.mockResolvedValue([container("notes-api-production-blue", suffixed("blue"))]);
    fsMock.rename.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));

    const guard = await guardCutover({
      appName: "notes-api",
      envName: "production",
      compose: { services: slotted } as unknown as ComposeFile,
      slotted,
      newProjectName: "notes-api-production-blue",
      oldProjectName: OLD,
      log: vi.fn(),
    });

    expect(guard.pinned).toBe(false);
    expect(fsMock.unlink).toHaveBeenCalledWith(PIN);
  });
});
