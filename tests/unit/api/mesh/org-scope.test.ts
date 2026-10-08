import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  peer: { id: "peer1", type: "persistent", organizationId: "org-bound" as string | null },
  importProjectBundle: vi.fn(async () => ({ projectId: "p1", appIds: [] })),
  buildProjectBundle: vi.fn(async () => ({})),
  transaction: vi.fn(),
}));

vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: async () => null }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/db", () => ({ db: { transaction: state.transaction } }));
vi.mock("@/lib/mesh/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer: async () => state.peer,
}));

const bundle = (transferType: string, appName = "web") => ({
  sourceInstanceId: "src",
  project: { name: "shop", displayName: "Shop", description: null, color: null },
  apps: [
    {
      name: appName,
      displayName: "Web",
      description: null,
      source: "direct",
      deployType: "compose",
      gitUrl: null,
      gitBranch: null,
      imageName: null,
      composeContent: "services:\n  web:\n    image: nginx\n",
      composeFilePath: null,
      rootDirectory: null,
      autoTraefikLabels: true,
      containerPort: 80,
      restartPolicy: null,
      exposedPorts: null,
      envContent: null,
      sortOrder: 0,
      volumes: [],
    },
  ],
  gitRef: null,
  transferType,
});

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/mesh/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { authorization: "Bearer t" },
  });

type Handler = (r: NextRequest) => Promise<Response>;

beforeEach(() => {
  state.peer.organizationId = "org-bound";
  state.importProjectBundle.mockClear();
  state.buildProjectBundle.mockClear();
  state.transaction.mockReset();
});

describe("mesh transfers act only in the peer's org", () => {
  describe("with transfers stubbed", () => {
    beforeEach(() => {
      vi.doMock("@/lib/mesh/transfers", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@/lib/mesh/transfers")>()),
        importProjectBundle: state.importProjectBundle,
        buildProjectBundle: state.buildProjectBundle,
      }));
    });

    const routes = {
      promote: async () => (await import("@/app/api/v1/mesh/promote/route")).POST as Handler,
      clone: async () => (await import("@/app/api/v1/mesh/clone/route")).POST as Handler,
    };
    const bodies = {
      promote: { bundle: bundle("promote"), environment: "production", orgId: "org-victim" },
      clone: { bundle: bundle("clone"), orgId: "org-victim" },
    };

    for (const name of ["promote", "clone"] as const) {
      it(`${name} imports into the bound org, not the one in the body`, async () => {
        const res = await (await routes[name]())(post(bodies[name]));
        expect(res.status).toBe(201);
        expect(state.importProjectBundle).toHaveBeenCalledTimes(1);
        expect(state.importProjectBundle.mock.calls[0]).toContain("org-bound");
        expect(state.importProjectBundle.mock.calls[0]).not.toContain("org-victim");
      });

      it(`${name} refuses a peer bound to no org`, async () => {
        state.peer.organizationId = null;
        const res = await (await routes[name]())(post(bodies[name]));
        expect(res.status).toBe(403);
        expect(state.importProjectBundle).not.toHaveBeenCalled();
      });
    }

    it("pull looks the project up inside the bound org", async () => {
      const { POST } = await import("@/app/api/v1/mesh/pull/route");
      const res = await (POST as Handler)(post({ projectId: "p-other" }));
      expect(res.status).toBe(200);
      expect(state.buildProjectBundle).toHaveBeenCalledWith(
        "p-other",
        expect.objectContaining({ organizationId: "org-bound" }),
      );
    });

    it("pull refuses a peer bound to no org", async () => {
      state.peer.organizationId = null;
      const { POST } = await import("@/app/api/v1/mesh/pull/route");
      const res = await (POST as Handler)(post({ projectId: "p1" }));
      expect(res.status).toBe(403);
      expect(state.buildProjectBundle).not.toHaveBeenCalled();
    });
  });

  describe("bundle names", () => {
    beforeEach(() => {
      vi.doUnmock("@/lib/mesh/transfers");
      vi.resetModules();
    });

    for (const bad of ["../../etc", "a/b", "-x", "Web", ""]) {
      it(`refuses an app named ${JSON.stringify(bad)} before touching the database`, async () => {
        const { importProjectBundle } = await import("@/lib/mesh/transfers");
        await expect(
          importProjectBundle("org-bound", bundle("promote", bad) as never, "production"),
        ).rejects.toThrow(/Invalid name/);
        expect(state.transaction).not.toHaveBeenCalled();
      });
    }
  });
});
