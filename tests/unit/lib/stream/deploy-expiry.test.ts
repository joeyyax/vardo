import { describe, it, expect, vi, beforeEach } from "vitest";

const { redisMock, dbMock, state } = vi.hoisted(() => {
  const state = {
    ttls: {} as Record<string, number>,
    rows: [] as { id: string; status: string }[],
    scanPages: [] as [string, string[]][],
  };
  const redisMock = {
    pexpire: vi.fn().mockResolvedValue(1),
    pttl: vi.fn(async (key: string) => state.ttls[key] ?? -1),
    scan: vi.fn(async () => state.scanPages.shift() ?? ["0", []]),
  };
  const dbMock = {
    select: vi.fn(() => ({ from: () => ({ where: async () => state.rows }) })),
  };
  return { redisMock, dbMock, state };
});

vi.mock("@/lib/redis", () => ({ redis: redisMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  DEPLOY_STREAM_TTL_MS,
  expireDeployStream,
  sweepDeployStreams,
} from "@/lib/stream/deploy-expiry";

beforeEach(() => {
  vi.clearAllMocks();
  state.ttls = {};
  state.rows = [];
  state.scanPages = [];
});

describe("expireDeployStream", () => {
  it("sets a 24 hour expiry on the deploy's stream", async () => {
    await expireDeployStream("d1");
    expect(redisMock.pexpire).toHaveBeenCalledWith("stream:deploy:d1", 24 * 60 * 60 * 1000);
    expect(DEPLOY_STREAM_TTL_MS).toBe(86_400_000);
  });
});

describe("sweepDeployStreams", () => {
  it("expires streams of terminal and missing deployments, skips live ones and ones that already expire", async () => {
    state.scanPages = [
      ["5", ["stream:deploy:ok", "stream:deploy:bad", "stream:deploy:rb", "stream:deploy:run"]],
      ["0", ["stream:deploy:gone", "stream:deploy:has-ttl", "stream:deploy:queued"]],
    ];
    state.ttls = { "stream:deploy:has-ttl": 5000 };
    state.rows = [
      { id: "ok", status: "success" },
      { id: "bad", status: "failed" },
      { id: "rb", status: "rolled_back" },
      { id: "run", status: "running" },
      { id: "queued", status: "queued" },
    ];

    const count = await sweepDeployStreams();

    const expired = redisMock.pexpire.mock.calls.map((c) => c[0]).sort();
    expect(expired).toEqual([
      "stream:deploy:bad",
      "stream:deploy:gone",
      "stream:deploy:ok",
      "stream:deploy:rb",
    ]);
    expect(count).toBe(4);
  });

  it("scans only deploy streams and uses SCAN", async () => {
    await sweepDeployStreams();
    expect(redisMock.scan).toHaveBeenCalledWith("0", "MATCH", "stream:deploy:*", "COUNT", 200);
  });
});
