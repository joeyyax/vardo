// A slot from before the overlay rename stops and rolls back on Vardo's docker-compose.vardo.yml.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { dbMock } from "@/tests/helpers/db";

const h = vi.hoisted(() => ({
  exec: vi.fn(),
  root: { dir: "" },
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: h.exec }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paths")>()),
  appEnvDir: (app: string, env: string) => join(h.root.dir, app, env),
}));
vi.mock("@/lib/docker/slot-guard", () => ({ assertSlotWithinApp: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ claimAppForOperation: vi.fn(async () => ({ release: vi.fn() })) }));
vi.mock("@/lib/docker/traefik-cutover", () => ({ clearCutoverPin: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/restart-policy", () => ({ restoreSlotRestart: vi.fn(async () => {}), demoteStandbyRestart: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn(async () => "blue") }));
vi.mock("@/lib/docker/shared-project", () => ({
  readSlotPartition: vi.fn(async () => null),
  readSlotBound: vi.fn(async () => []),
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn(async () => "evt") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  INSTANT_ROLLBACK_HEALTH_TIMEOUT: 40,
  INSTANT_ROLLBACK_POLL_INTERVAL: 5,
}));

import { performInstantRollback } from "@/lib/docker/instant-rollback";
import { stopStandbySlot } from "@/lib/docker/standby-slot";
import type { ResolvedEnv } from "@/lib/docker/resolve-env";

const LEGACY_OVERLAY = `services:
  web:
    labels:
      traefik.enable: "true"
    networks:
      - vardo-network
networks:
  vardo-network:
    external: true
`;

const RUNNING = JSON.stringify({ Service: "web", Name: "blog-production-green-web-1", State: "running" });

let appDir: string;

function composeCalls(): string[][] {
  return h.exec.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === "compose");
}

beforeEach(async () => {
  h.exec.mockReset();
  dbMock.reset();
  h.root.dir = await mkdtemp(join(tmpdir(), "vardo-legacy-"));
  appDir = join(h.root.dir, "blog", "production");
  // Blue was deployed by this version; green by one that wrote the legacy overlay.
  for (const slot of ["blue", "green"]) {
    await mkdir(join(appDir, slot), { recursive: true });
    await writeFile(join(appDir, slot, "docker-compose.yml"), "services:\n  web:\n    image: blog\n");
  }
  await writeFile(join(appDir, "blue", "docker-compose.override.yml"), LEGACY_OVERLAY);
  await writeFile(join(appDir, "blue", ".vardo.env"), "VARDO_GIT_SHA=local\nVARDO_GIT_SHORT_SHA=local\n");
  await writeFile(join(appDir, "green", "docker-compose.vardo.yml"), LEGACY_OVERLAY);

  dbMock.query.deployments.findFirst.mockResolvedValue({
    id: "dep-old", gitSha: "abc1234", gitMessage: "previous release", environmentId: "env-1",
  });
  h.exec.mockImplementation(async (_bin: string, args: string[]) => {
    if (args.includes("ps") && args.includes("-q")) return { stdout: "", stderr: "" };
    if (args.includes("ps")) return { stdout: `${RUNNING}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
});

afterEach(async () => {
  await rm(h.root.dir, { recursive: true, force: true });
});

describe("a slot with Vardo's legacy overlay", () => {
  it("stops with the legacy overlay layered on", async () => {
    await stopStandbySlot(appDir, "blog-production", "green");

    const stop = composeCalls().find((a) => a.includes("stop"))!;
    expect(stop).toEqual([
      "compose",
      "-f", join(appDir, "green", "docker-compose.yml"),
      "-f", join(appDir, "green", "docker-compose.vardo.yml"),
      "-p", "blog-production-green", "stop",
    ]);
  });

  it("rolls back onto the legacy overlay and stops the active slot with its own files", async () => {
    const env = { id: "env-1", name: "production", type: "production" } as ResolvedEnv;
    const result = await performInstantRollback({ appId: "app-1", appName: "blog", organizationId: "org-1", userId: "u1", env });

    expect(result).toMatchObject({ success: true, fromSlot: "blue", toSlot: "green" });
    const up = composeCalls().find((a) => a.includes("up"))!;
    expect(up.slice(0, 5)).toEqual([
      "compose",
      "-f", join(appDir, "green", "docker-compose.yml"),
      "-f", join(appDir, "green", "docker-compose.vardo.yml"),
    ]);
    expect(up).not.toContain("--env-file");

    const stop = composeCalls().find((a) => a.includes("stop") && a.includes("blog-production-blue"))!;
    expect(stop).toEqual(expect.arrayContaining([
      join(appDir, "blue", "docker-compose.override.yml"),
      "--env-file", join(appDir, "blue", ".vardo.env"),
    ]));
  });
});
