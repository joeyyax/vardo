import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

type RawContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports: never[];
  Labels: Record<string, string>;
};

/** Paths the fake daemon was asked for, in order. */
const requestedPaths: string[] = [];
let fleet: RawContainer[] = [];

function container(id: string, labels: Record<string, string>): RawContainer {
  return {
    Id: id,
    Names: [`/${id}`],
    Image: "img",
    State: "running",
    Status: "Up 2 hours",
    Ports: [],
    Labels: labels,
  };
}

/** Docker AND's label filters, so a container must carry every requested label. */
function matchFilters(path: string): RawContainer[] {
  const url = new URL(path, "http://docker");
  const raw = url.searchParams.get("filters");
  if (!raw) return fleet;
  const labels: string[] = JSON.parse(raw).label ?? [];
  return fleet.filter((c) =>
    labels.every((l) => {
      const [key, value] = l.split("=");
      return c.Labels[key] === value;
    }),
  );
}

vi.mock("node:child_process", () => ({ execFileSync: () => "1.47\n" }));

vi.mock("node:http", () => ({
  default: {
    request: (opts: { path: string }, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
      req.write = () => {};
      req.end = () => {
        requestedPaths.push(opts.path);
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        cb(res);
        process.nextTick(() => {
          res.emit("data", Buffer.from(JSON.stringify(matchFilters(opts.path))));
          res.emit("end");
        });
      };
      return req;
    },
  },
}));

const { listContainers } = await import("@/lib/docker/client");

beforeEach(() => {
  requestedPaths.length = 0;
  fleet = [];
});

describe("listContainers", () => {
  it("returns only the app's own containers when two orgs share an app name", async () => {
    fleet = [
      container("c-org1", { "vardo.project": "api", "vardo.project.id": "app-org1" }),
      container("c-org2", { "vardo.project": "api", "vardo.project.id": "app-org2" }),
    ];

    const result = await listContainers({ id: "app-org1", name: "api" });

    expect(result.map((c) => c.id)).toEqual(["c-org1"]);
  });

  it("does not query the name label once the id matched", async () => {
    fleet = [container("c-org1", { "vardo.project": "api", "vardo.project.id": "app-org1" })];

    await listContainers({ id: "app-org1", name: "api" });

    expect(requestedPaths).toHaveLength(1);
    expect(requestedPaths[0]).toContain(encodeURIComponent("vardo.project.id=app-org1"));
  });

  it("still finds an unlabelled legacy container, without pulling in the same-named foreign app", async () => {
    fleet = [
      container("c-legacy", { "host.project": "api" }),
      container("c-other-org", { "vardo.project": "api", "vardo.project.id": "app-org2" }),
    ];

    const result = await listContainers({ id: "app-legacy", name: "api" });

    expect(result.map((c) => c.id)).toEqual(["c-legacy"]);
  });

  it("scopes the id lookup by environment", async () => {
    fleet = [
      container("c-prod", {
        "vardo.project.id": "app-1",
        "vardo.environment": "production",
      }),
      container("c-staging", {
        "vardo.project.id": "app-1",
        "vardo.environment": "staging",
      }),
    ];

    const result = await listContainers({ id: "app-1", name: "api" }, "staging");

    expect(result.map((c) => c.id)).toEqual(["c-staging"]);
  });

  it("matches on the name alone when the caller has no app row", async () => {
    fleet = [
      container("c-vardo", { "vardo.project": "api", "vardo.project.id": "app-org2" }),
      container("c-legacy", { "host.project": "api" }),
    ];

    const result = await listContainers("api");

    expect(result.map((c) => c.id).sort()).toEqual(["c-legacy", "c-vardo"]);
  });

  it("lists every running container when no scope is given", async () => {
    fleet = [container("c-a", {}), container("c-b", {})];

    const result = await listContainers();

    expect(result.map((c) => c.id)).toEqual(["c-a", "c-b"]);
  });
});
