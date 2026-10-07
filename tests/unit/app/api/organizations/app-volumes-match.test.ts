// The volumes panel matched saved rows to live mounts by name, but rows are
// named from the mount path (#757) while Docker names a mount by its volume or
// host path. Nothing matched, so every volume read back as non-persistent and
// listed twice (#874).

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({ organization: { id: "org-1" }, membership: { role: "owner" } }),
}));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: vi.fn().mockResolvedValue({ id: "app-1", name: "notes" }) },
      volumes: {
        findMany: vi.fn().mockResolvedValue([
          { id: "v-data", name: "data", mountPath: "/data", type: "named", persistent: true, shared: false, source: null },
          { id: "v-cfg", name: "config", mountPath: "/config", type: "bind", persistent: false, shared: false, source: "/mnt/docker/notes/config" },
        ]),
      },
    },
  },
}));
vi.mock("@/lib/docker/app-containers", () => ({ listAppContainers: vi.fn().mockResolvedValue([{ id: "c1" }]) }));
vi.mock("@/lib/docker/client", () => ({
  resolveVolumeName: (m: { name: string }) => m.name,
  inspectContainer: vi.fn().mockResolvedValue({
    mounts: [
      { type: "volume", name: "notes_data", source: "/var/lib/docker/volumes/notes_data/_data", destination: "/data" },
      { type: "bind", name: "", source: "/mnt/docker/notes/config", destination: "/config" },
    ],
  }),
}));
vi.mock("child_process", () => ({
  exec: (_cmd: string, _opts: unknown, cb: (err: unknown, out?: unknown) => void) =>
    cb(null, { stdout: "4096\t/data", stderr: "" }),
}));

const { GET } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/volumes/route");

describe("GET app volumes", () => {
  it("matches each live mount to its saved row by mount path", async () => {
    const res = await GET(new NextRequest("http://localhost"), {
      params: Promise.resolve({ orgId: "org-1", appId: "app-1" }),
    });
    const { volumes } = await res.json();

    expect(volumes.map((v: { id: string; name: string; persistent: boolean }) => [v.id, v.name, v.persistent])).toEqual([
      ["v-data", "data", true],
      ["v-cfg", "config", false],
    ]);
  });
});
