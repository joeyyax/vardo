import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// sendHeartbeatToPeer and syncVisiblePeers
// ---------------------------------------------------------------------------
// DB and mesh client are mocked so these tests run without infrastructure.

const {
  mockMeshFetch,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbTransaction,
  mockTxDelete,
  mockTxDeleteWhere,
  mockTxInsert,
  mockTxInsertValues,
  mockOnConflictDoUpdate,
  mockLogWarn,
} = vi.hoisted(() => {
  const mockTxDeleteWhere = vi.fn().mockResolvedValue([]);
  const mockTxDelete = vi.fn(() => ({ where: mockTxDeleteWhere }));
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const mockTxInsertValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
  const mockTxInsert = vi.fn(() => ({ values: mockTxInsertValues }));
  const mockTx = { delete: mockTxDelete, insert: mockTxInsert };
  const mockDbTransaction = vi.fn(async (callback: (tx: typeof mockTx) => Promise<void>) =>
    callback(mockTx)
  );
  const mockDbUpdateSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) }));
  const mockDbUpdate = vi.fn(() => ({ set: mockDbUpdateSet }));
  const mockMeshFetch = vi.fn();
  const mockLogWarn = vi.fn();

  return {
    mockMeshFetch,
    mockDbUpdate,
    mockDbUpdateSet,
    mockDbTransaction,
    mockTxDelete,
    mockTxDeleteWhere,
    mockTxInsert,
    mockTxInsertValues,
    mockOnConflictDoUpdate,
    mockLogWarn,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
}));

vi.mock("@/lib/mesh/client", () => ({
  meshFetch: mockMeshFetch,
}));

vi.mock("nanoid", () => ({
  nanoid: () => "test-nanoid",
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    child: () => ({ warn: mockLogWarn, info: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock("@/lib/mesh/ip-allocator", () => ({
  toCidr: (ip: string) => `${ip}/32`,
  HUB_IP: "10.99.0.1",
}));

// Schema mock — just needs to be an object that drizzle operators can reference
vi.mock("@/lib/db/schema", () => ({
  meshPeers: {
    id: "id",
    instanceId: "instanceId",
    connectionType: "connectionType",
    sourceHubInstanceId: "sourceHubInstanceId",
    publicKey: "publicKey",
    internalIp: "internalIp",
    status: "status",
    name: "name",
    lastSeenAt: "lastSeenAt",
    updatedAt: "updatedAt",
  },
}));

import { sendHeartbeatToPeer, syncVisiblePeers } from "@/lib/mesh/heartbeat";

/** Cast mock call arg — vitest infers calls as an empty tuple, so we cast via unknown. */
function callArg<T>(mockFn: ReturnType<typeof vi.fn>, call = 0, arg = 0): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[call][arg] as T;
}

// Valid WireGuard Curve25519 public key fixture (43 base64 chars + "=")
const VALID_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function makePeer(overrides: Partial<{
  id: string;
  instanceId: string;
  name: string;
  type: "persistent" | "dev";
  status: "online" | "offline" | "unreachable";
  internalIp: string;
  allowedIps: string;
  publicKey: string;
  endpoint: string | null;
  lastSeenAt: string | null;
}> = {}) {
  return {
    id: "peer-1",
    instanceId: "inst-abc",
    name: "node-1",
    type: "persistent" as const,
    status: "online" as const,
    internalIp: "10.99.0.2",
    allowedIps: "10.99.0.2/32",
    publicKey: VALID_KEY,
    endpoint: null,
    lastSeenAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset transaction mock to call callback by default
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockDbTransaction.mockImplementation(async (callback: (tx: any) => Promise<void>) => {
    await callback({ delete: mockTxDelete, insert: mockTxInsert });
  });
  mockTxDeleteWhere.mockResolvedValue([]);
  mockOnConflictDoUpdate.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// sendHeartbeatToPeer
// ---------------------------------------------------------------------------

describe("sendHeartbeatToPeer", () => {
  it("returns true and marks peer online when peer responds ok", async () => {
    mockMeshFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, instance: { id: "hub-inst" }, peers: [] }),
    });

    const result = await sendHeartbeatToPeer("peer-id-1");

    expect(result).toBe(true);
    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "online" })
    );
  });

  it("returns false and marks peer offline when meshFetch throws", async () => {
    mockMeshFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sendHeartbeatToPeer("peer-id-1");

    expect(result).toBe(false);
    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "offline" })
    );
  });

  it("returns false and marks peer offline when response is not ok", async () => {
    mockMeshFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    const result = await sendHeartbeatToPeer("peer-id-1");

    expect(result).toBe(false);
    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "offline" })
    );
  });

  it("syncs visible peers when hub returns a non-empty manifest", async () => {
    const peer = makePeer({ instanceId: "inst-abc" });
    mockMeshFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        instance: { id: "hub-instance-id" },
        peers: [peer],
      }),
    });

    await sendHeartbeatToPeer("peer-id-1");

    expect(mockDbTransaction).toHaveBeenCalled();
    expect(mockTxInsert).toHaveBeenCalled();
  });

  it("does not call syncVisiblePeers when peers list is empty", async () => {
    mockMeshFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        instance: { id: "hub-instance-id" },
        peers: [],
      }),
    });

    await sendHeartbeatToPeer("peer-id-1");

    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("does not call syncVisiblePeers when instance id is missing from response", async () => {
    const peer = makePeer();
    mockMeshFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, peers: [peer] }),
    });

    await sendHeartbeatToPeer("peer-id-1");

    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("returns true even when syncVisiblePeers throws — sync failure is non-fatal", async () => {
    const peer = makePeer();
    mockMeshFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        instance: { id: "hub-instance-id" },
        peers: [peer],
      }),
    });
    mockDbTransaction.mockRejectedValue(new Error("DB down"));

    const result = await sendHeartbeatToPeer("peer-id-1");

    expect(result).toBe(true);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to sync visible peers")
    );
  });

  it("returns true and skips sync when response JSON is unparseable", async () => {
    mockMeshFetch.mockResolvedValue({
      ok: true,
      json: async () => { throw new Error("invalid json"); },
    });

    const result = await sendHeartbeatToPeer("peer-id-1");

    expect(result).toBe(true);
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// syncVisiblePeers
// ---------------------------------------------------------------------------

describe("syncVisiblePeers", () => {
  it("is a no-op when the peer list is empty", async () => {
    await syncVisiblePeers([], "hub-1");

    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("inserts valid peers into the transaction", async () => {
    const peer = makePeer({ instanceId: "inst-1", internalIp: "10.99.0.2" });

    await syncVisiblePeers([peer], "hub-1");

    expect(mockDbTransaction).toHaveBeenCalledOnce();
    expect(mockTxInsert).toHaveBeenCalled();
    const inserted = callArg<Array<{ instanceId: string }>>(mockTxInsertValues);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].instanceId).toBe("inst-1");
  });

  it("filters out peers with an invalid publicKey", async () => {
    const bad = makePeer({ publicKey: "not-a-valid-key", instanceId: "bad-inst" });
    const good = makePeer({ instanceId: "good-inst", id: "peer-2", publicKey: VALID_KEY });

    await syncVisiblePeers([bad, good], "hub-1");

    const inserted = callArg<Array<{ instanceId: string }>>(mockTxInsertValues);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].instanceId).toBe("good-inst");
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("invalid publicKey"));
  });

  it("filters out peers with an invalid internalIp (octet > 255)", async () => {
    const bad = makePeer({ internalIp: "999.0.0.1", instanceId: "bad-inst" });
    const good = makePeer({ instanceId: "good-inst", id: "peer-2" });

    await syncVisiblePeers([bad, good], "hub-1");

    const inserted = callArg<Array<{ instanceId: string }>>(mockTxInsertValues);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].instanceId).toBe("good-inst");
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("invalid internalIp"));
  });

  it("filters out peers with an invalid allowedIps", async () => {
    const bad = makePeer({ allowedIps: "not-an-ip/32", instanceId: "bad-inst" });
    const good = makePeer({ instanceId: "good-inst", id: "peer-2" });

    await syncVisiblePeers([bad, good], "hub-1");

    const inserted = callArg<Array<{ instanceId: string }>>(mockTxInsertValues);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].instanceId).toBe("good-inst");
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("invalid allowedIps"));
  });

  it("filters out peers with an empty instanceId", async () => {
    const bad = makePeer({ instanceId: "" });
    const good = makePeer({ instanceId: "good-inst", id: "peer-2" });

    await syncVisiblePeers([bad, good], "hub-1");

    const inserted = callArg<Array<{ instanceId: string }>>(mockTxInsertValues);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].instanceId).toBe("good-inst");
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("invalid instanceId"));
  });

  it("filters out peers with an instanceId exceeding 128 characters", async () => {
    const longId = "x".repeat(129);
    const bad = makePeer({ instanceId: longId });
    const good = makePeer({ instanceId: "good-inst", id: "peer-2" });

    await syncVisiblePeers([bad, good], "hub-1");

    const inserted = callArg<Array<{ instanceId: string }>>(mockTxInsertValues);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].instanceId).toBe("good-inst");
  });

  it("is a no-op when all peers fail validation", async () => {
    const bad = makePeer({ publicKey: "bad-key" });

    await syncVisiblePeers([bad], "hub-1");

    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("runs stale-collision deletes before insert, then prune — three delete calls total", async () => {
    const peer = makePeer();

    await syncVisiblePeers([peer], "hub-1");

    // Two pre-insert deletes (publicKey collision + internalIp collision) + one prune
    expect(mockTxDelete).toHaveBeenCalledTimes(3);
    expect(mockTxInsert).toHaveBeenCalledTimes(1);
  });

  it("sets connectionType to visible on inserted peers", async () => {
    const peer = makePeer({ instanceId: "inst-vis" });

    await syncVisiblePeers([peer], "hub-1");

    const inserted = callArg<Array<{ connectionType: string; sourceHubInstanceId: string }>>(mockTxInsertValues);
    expect(inserted[0].connectionType).toBe("visible");
    expect(inserted[0].sourceHubInstanceId).toBe("hub-1");
  });

  it("falls back to toCidr(internalIp) when peer has no allowedIps", async () => {
    const peer = makePeer({ allowedIps: "", instanceId: "inst-noallowedips" });

    await syncVisiblePeers([peer], "hub-1");

    const inserted = callArg<Array<{ allowedIps: string; internalIp: string }>>(mockTxInsertValues);
    expect(inserted[0].allowedIps).toBe(`${peer.internalIp}/32`);
  });
});
