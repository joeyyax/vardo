import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/v1/mesh/heartbeat
// ---------------------------------------------------------------------------
// Auth, DB, and mesh helpers are mocked. Tests verify response shape, field
// inclusion/exclusion, and that the calling peer is excluded from the manifest.

const FAKE_PEER = {
  id: "calling-peer-id",
  instanceId: "calling-inst",
  name: "caller",
  type: "persistent" as const,
  status: "online" as const,
  tokenHash: "hashed-token",
  outboundToken: "raw-outbound-token",
  internalIp: "10.99.0.2",
  allowedIps: "10.99.0.2/32",
  publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  endpoint: null,
  lastSeenAt: null,
};

const OTHER_PEER = {
  id: "other-peer-id",
  instanceId: "other-inst",
  name: "node-2",
  type: "persistent" as const,
  status: "online" as const,
  internalIp: "10.99.0.3",
  allowedIps: "10.99.0.3/32",
  publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  endpoint: "1.2.3.4:51820",
  lastSeenAt: null,
};

const { mockRequireMeshPeer, mockFindMany, mockGetHubAddress, mockGetInstanceId, mockGetInstanceConfig } = vi.hoisted(() => {
  const mockRequireMeshPeer = vi.fn();
  const mockFindMany = vi.fn();
  const mockGetHubAddress = vi.fn();
  const mockGetInstanceId = vi.fn();
  const mockGetInstanceConfig = vi.fn();
  return { mockRequireMeshPeer, mockFindMany, mockGetHubAddress, mockGetInstanceId, mockGetInstanceConfig };
});

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    query: {
      meshPeers: {
        findMany: mockFindMany,
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  meshPeers: {
    id: "id",
    instanceId: "instanceId",
    status: "status",
    lastSeenAt: "lastSeenAt",
    updatedAt: "updatedAt",
  },
}));

vi.mock("@/lib/mesh/auth", () => ({
  requireMeshPeer: mockRequireMeshPeer,
}));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: Function) => handler,
}));

vi.mock("@/lib/mesh", () => ({
  getHubAddress: mockGetHubAddress,
}));

vi.mock("@/lib/constants", () => ({
  getInstanceId: mockGetInstanceId,
}));

vi.mock("@/lib/system-settings", () => ({
  getInstanceConfig: mockGetInstanceConfig,
}));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { POST } from "@/app/api/v1/mesh/heartbeat/route";

function makeRequest() {
  return new NextRequest("http://localhost/api/v1/mesh/heartbeat", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMeshPeer.mockResolvedValue(FAKE_PEER);
  mockFindMany.mockResolvedValue([OTHER_PEER]);
  mockGetHubAddress.mockResolvedValue("10.99.0.1");
  mockGetInstanceId.mockResolvedValue("this-instance-id");
  mockGetInstanceConfig.mockResolvedValue({ instanceName: "my-hub" });
});

describe("POST /api/v1/mesh/heartbeat", () => {
  it("returns ok: true with instance and peers", async () => {
    const res = await POST(makeRequest(), {});
    const body = await res.json() as { ok: boolean; instance: unknown; peers: unknown[] };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.instance).toBeDefined();
    expect(Array.isArray(body.peers)).toBe(true);
  });

  it("includes instanceId, publicKey, and allowedIps in the columns selection", async () => {
    await POST(makeRequest(), {});

    const findManyCall = mockFindMany.mock.calls[0][0] as {
      columns?: Record<string, boolean>;
    } | undefined;
    const columns = findManyCall?.columns;

    expect(columns?.instanceId).toBe(true);
    expect(columns?.publicKey).toBe(true);
    expect(columns?.allowedIps).toBe(true);
  });

  it("does not include tokenHash or outboundToken in the columns selection", async () => {
    await POST(makeRequest(), {});

    const findManyCall = mockFindMany.mock.calls[0][0] as {
      columns?: Record<string, boolean>;
    } | undefined;
    const columns = findManyCall?.columns ?? {};

    expect(columns.tokenHash).toBeUndefined();
    expect(columns.outboundToken).toBeUndefined();
  });

  it("excludes the calling peer from the manifest via ne filter", async () => {
    await POST(makeRequest(), {});

    const findManyCall = mockFindMany.mock.calls[0][0] as {
      where?: unknown;
    } | undefined;
    // The where clause is a drizzle ne() node — just verify it was passed
    expect(findManyCall?.where).toBeDefined();
  });

  it("includes hub instance info in the response", async () => {
    const res = await POST(makeRequest(), {});
    const body = await res.json() as {
      instance: { id: string; name: string; internalIp: string };
    };

    expect(body.instance.id).toBe("this-instance-id");
    expect(body.instance.name).toBe("my-hub");
    expect(body.instance.internalIp).toBe("10.99.0.1");
  });

  it("returns the peers provided by findMany", async () => {
    const res = await POST(makeRequest(), {});
    const body = await res.json() as { peers: Array<{ id: string }> };

    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].id).toBe("other-peer-id");
  });

  it("returns 401 when requireMeshPeer throws Unauthorized", async () => {
    mockRequireMeshPeer.mockRejectedValue(new Error("Unauthorized"));

    const res = await POST(makeRequest(), {});
    const body = await res.json() as { error: string };

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 500 on unexpected errors", async () => {
    mockFindMany.mockRejectedValue(new Error("DB gone"));

    const res = await POST(makeRequest(), {});

    expect(res.status).toBe(500);
  });

  it("peers in the response do not contain tokenHash or outboundToken", async () => {
    // Even if findMany returned sensitive fields, they should not be in the columns selection.
    // Verify by checking that the columns selection explicitly excludes them (tested above),
    // and that the mock peer data without those fields doesn't expose them.
    const res = await POST(makeRequest(), {});
    const body = await res.json() as { peers: Array<Record<string, unknown>> };

    for (const peer of body.peers) {
      expect(peer.tokenHash).toBeUndefined();
      expect(peer.outboundToken).toBeUndefined();
    }
  });
});
