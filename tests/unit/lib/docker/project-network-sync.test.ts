import { describe, it, expect } from "vitest";
import {
  networkPeers,
  prepareProjectNetwork,
  syncProjectNetwork,
  type DockerRun,
} from "@/lib/docker/project-network-sync";
import type { ComposeFile } from "@/lib/docker/compose-types";

const NET = "vardo-p-proj123-production";

/** A fake docker CLI answering by subcommand. */
function fakeDocker(answers: Partial<Record<string, string | Error>>) {
  const calls: string[][] = [];
  const run: DockerRun = async (args) => {
    calls.push(args);
    const key = args[0] === "network" ? `network ${args[1]}` : args[0];
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return { stdout: answer ?? "" };
  };
  return { run, calls };
}

const compose: ComposeFile = {
  services: {
    web: { name: "web", image: "web" },
    postgres: { name: "postgres", image: "postgres:17" },
  },
};

function ctx(overrides: Partial<{ name: string; projectId: string | null }> = {}) {
  const lines: string[] = [];
  return {
    lines,
    value: {
      app: { id: "me", name: "shop-db", projectId: "proj123", ...overrides },
      envName: "production",
      compose,
      log: (line: string) => {
        lines.push(line);
      },
    },
  };
}

describe("networkPeers", () => {
  it("parses service, app id and app name", async () => {
    const { run, calls } = fakeDocker({ ps: "postgres\ta1\tshop-db\n\t\t\nweb\ta2\t\n" });
    expect(await networkPeers(NET, run)).toEqual([
      { service: "postgres", appId: "a1", appName: "shop-db" },
      { service: "web", appId: "a2", appName: "a2" },
    ]);
    expect(calls[0]).toContain(`network=${NET}`);
  });
});

describe("prepareProjectNetwork", () => {
  it("creates the network with the project label and returns its name", async () => {
    const { run, calls } = fakeDocker({ ps: "shop-east\ta2\tshop-east\n" });
    const c = ctx();
    expect(await prepareProjectNetwork(c.value, run)).toBe(NET);
    const create = calls.find((a) => a[1] === "create")!;
    expect(create).toContain("vardo.network.project=proj123");
    expect(create.at(-1)).toBe(NET);
  });

  it("accepts a network that already exists", async () => {
    const exists = Object.assign(new Error("failed"), { stderr: `Error response from daemon: network with name ${NET} already exists` });
    const { run } = fakeDocker({ "network create": exists });
    expect(await prepareProjectNetwork(ctx().value, run)).toBe(NET);
  });

  it("leaves the app off the network when another app has a service by the same name", async () => {
    const { run, calls } = fakeDocker({ ps: "postgres\ta1\tother-db\n" });
    const c = ctx();
    expect(await prepareProjectNetwork(c.value, run)).toBeNull();
    expect(calls.some((a) => a[1] === "create")).toBe(false);
    expect(c.lines[0]).toContain(`project network ${NET}: not attached`);
    expect(c.lines[0]).toContain('"postgres" (also in other-db)');
    expect(c.lines[0]).toContain("Rename the service");
  });

  it("ignores the app's own containers from the other slot", async () => {
    const { run } = fakeDocker({ ps: "postgres\tme\tshop-db\nweb\tme\tshop-db\n" });
    expect(await prepareProjectNetwork(ctx().value, run)).toBe(NET);
  });

  it("skips Vardo itself", async () => {
    const { run, calls } = fakeDocker({});
    expect(await prepareProjectNetwork(ctx({ name: "vardo" }).value, run)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("deploys without it when the network can't be created", async () => {
    const { run } = fakeDocker({ "network create": new Error("daemon unavailable") });
    const c = ctx();
    expect(await prepareProjectNetwork(c.value, run)).toBeNull();
    expect(c.lines[0]).toContain("couldn't create it");
  });
});

describe("syncProjectNetwork", () => {
  it("connects a held shared service under its service name", async () => {
    const { run, calls } = fakeDocker({ inspect: JSON.stringify({ "shop-db-production_default": {} }) });
    const changed = await syncProjectNetwork([{ container: "shop-db-production-shared-postgres-1", alias: "postgres" }], NET, run);
    expect(changed).toEqual(["postgres"]);
    expect(calls).toContainEqual(["network", "connect", "--alias", "postgres", NET, "shop-db-production-shared-postgres-1"]);
  });

  it("does nothing for a container already on it", async () => {
    const { run, calls } = fakeDocker({ inspect: JSON.stringify({ [NET]: {} }) });
    expect(await syncProjectNetwork([{ container: "c", alias: "postgres" }], NET, run)).toEqual([]);
    expect(calls.filter((a) => a[0] === "network")).toEqual([]);
  });

  it("disconnects another project's network", async () => {
    const { run, calls } = fakeDocker({ inspect: JSON.stringify({ "vardo-p-old-production": {}, default: {} }) });
    await syncProjectNetwork([{ container: "c", alias: "postgres" }], null, run);
    expect(calls).toContainEqual(["network", "disconnect", "vardo-p-old-production", "c"]);
    expect(calls.some((a) => a[1] === "connect")).toBe(false);
  });

  it("skips a container that's gone", async () => {
    const { run } = fakeDocker({ inspect: new Error("No such object") });
    expect(await syncProjectNetwork([{ container: "c", alias: "postgres" }], NET, run)).toEqual([]);
  });
});
