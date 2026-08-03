// ---------------------------------------------------------------------------
// Figures are the live homelab host on 2026-08-03, 6.85 days after boot: the
// cgroup root reads oom_kill 171, system.slice 170, and exactly one container
// scope still carries a count of its own — browser-mcp, which is running with
// State.OOMKilled and RestartCount 0. Every memory.events.local reads 0, so all
// 170 happened inside container scopes rather than at the slice itself.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  containerScope,
  parseOomKill,
  readContainerOomKills,
  readFleetOomKills,
  readOomKills,
  oomCountersReadable,
} from "@/lib/docker/oom-counter";

const BROWSER_MCP = "b9760e18c0e0263fc35d1464f080228e5b89e2da9fa3e893e7d19b9fdc54334c";

const ROOT_EVENTS = `low 0
high 0
max 1846329
oom 10
oom_kill 171
oom_group_kill 0
`;

const SLICE_EVENTS = ROOT_EVENTS.replace("oom_kill 171", "oom_kill 170");
const SCOPE_EVENTS = `low 0
high 0
max 3376
oom 0
oom_kill 1
oom_group_kill 0
`;

let root: string;
/** A path with no cgroup mount under it, for the not-readable case. */
let bare: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vardo-cgroup-"));
  bare = await mkdtemp(join(tmpdir(), "vardo-nocgroup-"));

  await writeFile(join(root, "memory.events"), ROOT_EVENTS);
  const slice = join(root, "system.slice");
  await mkdir(slice, { recursive: true });
  await writeFile(join(slice, "memory.events"), SLICE_EVENTS);
  const scope = join(slice, `docker-${BROWSER_MCP}.scope`);
  await mkdir(scope, { recursive: true });
  await writeFile(join(scope, "memory.events"), SCOPE_EVENTS);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

describe("parseOomKill", () => {
  it("reads the counter out of a memory.events file", () => {
    expect(parseOomKill(ROOT_EVENTS)).toBe(171);
  });

  it("does not mistake oom_group_kill for oom_kill", () => {
    expect(parseOomKill("oom_group_kill 12\noom_kill 3\n")).toBe(3);
  });

  it("returns null when the line is absent", () => {
    expect(parseOomKill("low 0\nhigh 0\n")).toBeNull();
  });

  it("distinguishes a genuine zero from an unreadable file", () => {
    expect(parseOomKill("oom_kill 0\n")).toBe(0);
  });
});

describe("containerScope", () => {
  it("builds the systemd scope path Docker uses", () => {
    expect(containerScope(BROWSER_MCP)).toBe(`system.slice/docker-${BROWSER_MCP}.scope`);
  });
});

describe("readFleetOomKills", () => {
  it("counts every kill under the slice the containers live in", async () => {
    expect(await readFleetOomKills(root)).toBe(170);
  });

  it("returns null when the host cgroup root is not mounted", async () => {
    expect(await readFleetOomKills(bare)).toBeNull();
  });

  it("returns null rather than zero on a path that does not exist at all", async () => {
    expect(await readFleetOomKills("/nonexistent-cgroup-root")).toBeNull();
  });
});

describe("readContainerOomKills", () => {
  it("attributes a kill to the container that is still running", async () => {
    expect(await readContainerOomKills(BROWSER_MCP, root)).toBe(1);
  });

  it("returns null once the container's cgroup is gone", async () => {
    expect(await readContainerOomKills("a".repeat(64), root)).toBeNull();
  });
});

describe("readOomKills", () => {
  it("reads the whole-host total from the cgroup root", async () => {
    expect(await readOomKills("", root)).toBe(171);
  });
});

describe("oomCountersReadable", () => {
  it("is true where the host cgroup root is mounted", async () => {
    expect(await oomCountersReadable(root)).toBe(true);
  });

  it("is false where it is not", async () => {
    expect(await oomCountersReadable(bare)).toBe(false);
  });
});

describe("attribution coverage", () => {
  // The gap this whole module exists for: the slice counter holds 170 kills and
  // the surviving per-container counters account for 1. The other 169 are in
  // cgroups destroyed with their containers and can only ever be a count.
  it("leaves the bulk of the slice total unattributable", async () => {
    const fleet = (await readFleetOomKills(root)) ?? 0;
    const attributed = (await readContainerOomKills(BROWSER_MCP, root)) ?? 0;
    expect(fleet - attributed).toBe(169);
  });
});
