// ---------------------------------------------------------------------------
// A promoted slot has to come off `restart: no`, or it never recovers from a
// crash. The demote sets that policy, so a service declaring none of its own
// cannot be read as "leave it alone".
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsyncMock, execFileMock } = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });
  return { execFileAsyncMock, execFileMock };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { restoreSlotRestart, demoteStandbyRestart } from "@/lib/docker/restart-policy";

/** `ps -a` reports one container per service; `config` reports the declared policies. */
function dockerWith(services: Record<string, { restart?: string }>) {
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      const lines = Object.keys(services).map((name) =>
        JSON.stringify({ ID: `id-${name}`, Service: name }),
      );
      return { stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    if (args.includes("config")) {
      return { stdout: JSON.stringify({ services }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

/** Restart policy each container id was updated to. */
function updates(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, args] of execFileAsyncMock.mock.calls as [string, string[]][]) {
    if (args[0] !== "update") continue;
    const policy = args[1].replace("--restart=", "");
    for (const id of args.slice(2)) out[id] = policy;
  }
  return out;
}

describe("restoreSlotRestart", () => {
  beforeEach(() => vi.clearAllMocks());

  it("puts each service's declared policy back", async () => {
    dockerWith({ web: { restart: "unless-stopped" }, worker: { restart: "on-failure" } });
    await restoreSlotRestart(["-f", "docker-compose.yml"], "app-production-blue", "/slot");

    expect(updates()).toEqual({ "id-web": "unless-stopped", "id-worker": "on-failure" });
  });

  it("restores a service that declares no policy rather than leaving it pinned", async () => {
    dockerWith({ web: {} });
    await restoreSlotRestart(["-f", "docker-compose.yml"], "app-production-blue", "/slot");

    expect(updates()).toEqual({ "id-web": "unless-stopped" });
  });

  it("survives Docker failing without throwing at the caller", async () => {
    execFileAsyncMock.mockRejectedValue(new Error("daemon unreachable"));
    await expect(
      restoreSlotRestart(["-f", "docker-compose.yml"], "app-production-blue", "/slot"),
    ).resolves.toBeUndefined();
  });
});

describe("demoteStandbyRestart", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins every container in the slot to no", async () => {
    dockerWith({ web: { restart: "unless-stopped" }, worker: {} });
    await demoteStandbyRestart(["-f", "docker-compose.yml"], "app-production-blue", "/slot");

    expect(updates()).toEqual({ "id-web": "no", "id-worker": "no" });
  });

  it("does nothing when the slot has no containers", async () => {
    dockerWith({});
    await demoteStandbyRestart(["-f", "docker-compose.yml"], "app-production-blue", "/slot");

    expect(updates()).toEqual({});
  });
});
