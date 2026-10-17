import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Build target settings: the private key is write-only, a moved host is pinned again, and order is overflow order.

const { store, scans, mesh } = vi.hoisted(() => ({ store: new Map<string, string>(), scans: [] as string[], mesh: [] as unknown[] }));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => ({}) }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async (key: string) => store.get(key) || null,
  setSystemSetting: async (key: string, value: string) => void store.set(key, value),
}));
vi.mock("@/lib/mesh/build-peers", () => ({ meshBuildPeers: async () => mesh }));
vi.mock("@/lib/docker/build-targets", async (original) => ({
  ...(await original<typeof import("@/lib/docker/build-targets")>()),
  hostKeyFingerprints: async () => ["SHA256:abc (ED25519)"],
  scanHostKey: async (host: string, port: number) => (scans.push(`${host}:${port}`), `[${host}]:${port} ssh-ed25519 AAAA`),
  targetDockerVersion: async () => "29.4.0",
}));

import { GET, POST } from "@/app/api/v1/admin/build-targets/route";
import { POST as TEST } from "@/app/api/v1/admin/build-targets/test/route";

type Handler = (r?: NextRequest) => Promise<Response>;

const request = (path: string, body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/${path}`, { method: "POST", body: JSON.stringify(body) });
const post = (body: unknown) => (POST as unknown as Handler)(request("build-targets", body));
const test = async (id: string) => (await (TEST as unknown as Handler)(request("build-targets/test", { id }))).json();
const get = async () => (await (GET as unknown as Handler)()).json();
const stored = () => JSON.parse(store.get("build_targets") || '{"targets":[]}').targets;

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
const lh = { action: "save", name: "Long House", host: "10.99.0.2", port: 22, user: "vardo", privateKey: KEY, maxConcurrent: 2 };

const MESH_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nmeshkey\n-----END OPENSSH PRIVATE KEY-----\n";
const linked = (over: Record<string, unknown> = {}) => ({
  peerId: "lhpeer", name: "Long House", host: "10.99.0.2", port: 22, user: "vardo", privateKey: MESH_KEY,
  hostKey: "10.99.0.2 ssh-ed25519 AAAAC3", waiting: null, accepts: true, ...over,
});

beforeEach(() => {
  store.clear();
  scans.length = 0;
  mesh.length = 0;
});

describe("/api/v1/admin/build-targets", () => {
  it("is empty until a target is added, and says whether the registry is set", async () => {
    expect(await get()).toEqual({ configured: true, registry: false, targets: [] });
  });

  it("saves a target and never returns its private key", async () => {
    expect((await post(lh)).status).toBe(200);
    expect(stored()[0]).toMatchObject({ host: "10.99.0.2", privateKey: `${KEY}\n`, hostKey: null, maxConcurrent: 2 });
    const body = await get();
    expect(body.targets).toEqual([
      { id: expect.any(String), kind: "ssh", name: "Long House", host: "10.99.0.2", port: 22, user: "vardo", maxConcurrent: 2, hasKey: true, hostKey: null },
    ]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  it("requires a key for a new target and keeps the stored one when left blank", async () => {
    expect((await post({ ...lh, privateKey: undefined })).status).toBe(400);
    await post(lh);
    const id = stored()[0].id;
    await post({ ...lh, id, privateKey: "", maxConcurrent: 3 });
    expect(stored()[0]).toMatchObject({ privateKey: `${KEY}\n`, maxConcurrent: 3 });
  });

  it("refuses a host or user that could inject ssh options", async () => {
    expect((await post({ ...lh, host: "10.99.0.2\nProxyCommand sh" })).status).toBe(400);
    expect((await post({ ...lh, host: "-oProxyCommand=sh" })).status).toBe(400);
    expect((await post({ ...lh, user: "root -o x" })).status).toBe(400);
    expect(stored()).toEqual([]);
  });

  it("pins the host key on the first test and keeps it after", async () => {
    await post(lh);
    const id = stored()[0].id;
    expect(await test(id)).toEqual({ ok: true, pinned: true, fingerprints: ["SHA256:abc (ED25519)"], dockerVersion: "29.4.0" });
    expect(stored()[0].hostKey).toBe("[10.99.0.2]:22 ssh-ed25519 AAAA");
    expect(await test(id)).toMatchObject({ ok: true, pinned: false });
    expect(scans).toEqual(["10.99.0.2:22"]);
  });

  it("drops the pinned key when the host or port changes, and on request", async () => {
    await post(lh);
    const id = stored()[0].id;
    await test(id);
    await post({ ...lh, id, privateKey: "", name: "renamed" });
    expect(stored()[0].hostKey).not.toBeNull();
    await post({ ...lh, id, privateKey: "", port: 2222 });
    expect(stored()[0].hostKey).toBeNull();
    await test(id);
    await post({ action: "forget-host-key", id });
    expect(stored()[0].hostKey).toBeNull();
  });

  it("reorders and removes targets", async () => {
    await post(lh);
    await post({ ...lh, name: "Hetzner", host: "builder.example.com" });
    const [a, b] = stored().map((t: { id: string }) => t.id);
    await post({ action: "move", id: b, direction: "up" });
    expect(stored().map((t: { id: string }) => t.id)).toEqual([b, a]);
    await post({ action: "remove", id: b });
    expect(stored().map((t: { id: string }) => t.id)).toEqual([a]);
    expect((await post({ action: "remove", id: "nope" })).status).toBe(404);
  });

  it("lists a linked instance that accepts builds, without its key", async () => {
    mesh.push(linked());
    const body = await get();
    expect(body.targets).toEqual([
      { id: "mesh-lhpeer", kind: "mesh", name: "Long House", host: "10.99.0.2", port: 22, user: "vardo", maxConcurrent: 1, hasKey: true, hostKey: ["SHA256:abc (ED25519)"], waiting: null },
    ]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  it("changes a linked instance's limit and place, but not its host, key or listing", async () => {
    mesh.push(linked());
    await post(lh);
    expect((await post({ action: "limit", id: "mesh-lhpeer", maxConcurrent: 0 })).status).toBe(200);
    expect(stored().find((t: { id: string }) => t.id === "mesh-lhpeer")).toEqual({ id: "mesh-lhpeer", kind: "mesh", peerId: "lhpeer", maxConcurrent: 0 });
    await post({ action: "move", id: "mesh-lhpeer", direction: "up" });
    expect(stored().map((t: { kind: string }) => t.kind)).toEqual(["mesh", "ssh"]);
    expect((await post({ action: "remove", id: "mesh-lhpeer" })).status).toBe(400);
    expect((await post({ action: "forget-host-key", id: "mesh-lhpeer" })).status).toBe(400);
    expect((await post({ ...lh, id: "mesh-lhpeer", host: "evil.example.com" })).status).toBe(400);
    expect(JSON.stringify(stored())).not.toContain("meshkey");
  });

  it("never scans a linked instance's host key, which only the key exchange sets", async () => {
    mesh.push(linked({ hostKey: null, waiting: "Long House hasn't sent its mesh SSH host key yet" }));
    expect(await test("mesh-lhpeer")).toEqual({ ok: false, error: "Long House hasn't sent its mesh SSH host key yet" });
    expect(scans).toEqual([]);
    mesh[0] = linked();
    expect(await test("mesh-lhpeer")).toMatchObject({ ok: true, pinned: false, dockerVersion: "29.4.0" });
    expect(scans).toEqual([]);
  });
});
