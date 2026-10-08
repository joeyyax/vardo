// #893: "Restart all" restarts the shared services in project `vardo` and never starts the frontend there.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { spawnMock, execMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execMock: vi.fn() }));

vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execMock }));
vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => {} }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/paths", () => ({ resolveVardoComposeFile: () => "/opt/vardo/docker-compose.yml" }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({ PATH: "/bin" }) }));

const POST = (await import("@/app/api/v1/admin/maintenance/restart/route")).POST as unknown as (
  r: NextRequest,
) => Promise<Response>;

function post(body: unknown) {
  return new NextRequest("http://localhost/api/v1/admin/maintenance/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function spawnedArgs(): string[] {
  vi.advanceTimersByTime(1500);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0][1];
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset().mockReturnValue({ unref: vi.fn() });
  execMock.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("config")) return { stdout: "frontend\npostgres\nredis\ntraefik\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
});

afterEach(() => vi.useRealTimers());

describe("restart all", () => {
  it("runs in project vardo and never names the frontend", async () => {
    const res = await POST(post({}));
    const args = spawnedArgs();

    expect(res.status).toBe(200);
    expect(args.slice(0, 5)).toEqual(["compose", "-p", "vardo", "-f", "/opt/vardo/docker-compose.yml"]);
    expect(args).not.toContain("frontend");
    expect(args.slice(args.indexOf("up"))).toEqual(["up", "-d", "--no-deps", "postgres", "redis", "traefik"]);
  });

  it("keeps the scrubbed docker env", async () => {
    await POST(post({}));
    vi.advanceTimersByTime(1500);

    expect(spawnMock.mock.calls[0][2].env).toEqual({ PATH: "/bin" });
  });
});

describe("restart one", () => {
  it("restarts a shared service by its compose service name", async () => {
    execMock.mockResolvedValue({ stdout: "vardo\tpostgres\n", stderr: "" });

    await POST(post({ service: "vardo-postgres" }));

    expect(spawnedArgs().slice(1)).toEqual([
      "-p", "vardo", "-f", "/opt/vardo/docker-compose.yml", "up", "-d", "--no-deps", "postgres",
    ]);
  });

  it("refuses a frontend in a slot project", async () => {
    execMock.mockResolvedValue({ stdout: "vardo-production-blue\tfrontend\n", stderr: "" });

    const res = await POST(post({ service: "vardo-production-blue-frontend-1" }));
    vi.advanceTimersByTime(1500);

    expect(res.status).toBe(409);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a frontend even when it sits in project vardo", async () => {
    execMock.mockResolvedValue({ stdout: "vardo\tfrontend\n", stderr: "" });

    const res = await POST(post({ service: "vardo-frontend" }));
    vi.advanceTimersByTime(1500);

    expect(res.status).toBe(409);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
