// Env in a mesh bundle leaves as plaintext and lands encrypted under the
// destination org's key; ciphertext from another instance is refused.

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

const state = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  existingApp: null as { id: string } | null,
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/constants", () => ({ getInstanceId: async () => "src-instance" }));
vi.mock("@/lib/db", () => {
  const tx = {
    query: {
      projects: { findFirst: async () => ({ id: "proj-dest" }) },
      apps: {
        findFirst: vi.fn(async () => state.existingApp),
      },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(v);
        },
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        state.inserts.push(v);
      },
    }),
  };
  return {
    db: {
      query: { projects: { findFirst: async () => state.project } },
      transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import { encrypt, decrypt } from "@/lib/crypto/encrypt";
import {
  BundleRejectedError,
  buildProjectBundle,
  importProjectBundle,
  sealBundleEnv,
  type ProjectBundle,
} from "@/lib/mesh/transfers";

const ENV = "DATABASE_URL=postgres://u:p@db/app\nSECRET=hunter2";

function appRow(envContent: string | null) {
  return {
    name: "web",
    displayName: "Web",
    description: null,
    source: "direct",
    deployType: "compose",
    gitUrl: null,
    gitBranch: null,
    imageName: null,
    composeContent: "services: {}",
    composeFilePath: null,
    rootDirectory: null,
    autoTraefikLabels: true,
    containerPort: 80,
    backendProtocol: null,
    restartPolicy: null,
    exposedPorts: null,
    envContent,
    sortOrder: 0,
    volumes: [],
  };
}

function bundle(transferType: ProjectBundle["transferType"], envContent: string | null): ProjectBundle {
  const app = appRow(envContent);
  return {
    sourceInstanceId: "src",
    project: { name: "shop", displayName: "Shop", description: null, color: null },
    apps: [app as ProjectBundle["apps"][number]],
    gitRef: null,
    transferType,
  };
}

/** Ciphertext as another instance, with its own master key, would write it. */
function foreignCiphertext(value: string, orgId: string): string {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  process.env.ENCRYPTION_MASTER_KEY = "2".repeat(64);
  try {
    return encrypt(value, orgId);
  } finally {
    process.env.ENCRYPTION_MASTER_KEY = key;
  }
}

beforeEach(() => {
  state.project = null;
  state.existingApp = null;
  state.updates.length = 0;
  state.inserts.length = 0;
});

describe("buildProjectBundle", () => {
  it("decrypts env with the source org's key", async () => {
    state.project = {
      name: "shop", displayName: "Shop", description: null, color: null,
      organizationId: "org-src",
      apps: [{ ...appRow(encrypt(ENV, "org-src")), parentAppId: null }],
    };
    const b = await buildProjectBundle("p1", { transferType: "promote", includeEnvVars: true });
    expect(b.apps[0].envContent).toBe(ENV);
  });

  it("leaves env out unless asked", async () => {
    state.project = {
      name: "shop", displayName: "Shop", description: null, color: null,
      organizationId: "org-src",
      apps: [{ ...appRow(encrypt(ENV, "org-src")), parentAppId: null }],
    };
    const b = await buildProjectBundle("p1", { transferType: "promote" });
    expect(b.apps[0].envContent).toBeNull();
  });

  it("fails rather than sending env it cannot read", async () => {
    state.project = {
      name: "shop", displayName: "Shop", description: null, color: null,
      organizationId: "org-src",
      apps: [{ ...appRow(encrypt(ENV, "org-other")), parentAppId: null }],
    };
    await expect(
      buildProjectBundle("p1", { transferType: "promote", includeEnvVars: true }),
    ).rejects.toThrow(/cannot be decrypted/);
  });
});

describe("sealBundleEnv", () => {
  it("encrypts plaintext under the destination org", () => {
    const sealed = sealBundleEnv("web", ENV, "org-dest")!;
    expect(sealed).not.toContain("hunter2");
    expect(decrypt(sealed, "org-dest")).toBe(ENV);
  });

  it("stores empty env as null", () => {
    expect(sealBundleEnv("web", "  \n", "org-dest")).toBeNull();
    expect(sealBundleEnv("web", null, "org-dest")).toBeNull();
  });

  it("refuses ciphertext from another instance", () => {
    expect(() => sealBundleEnv("web", foreignCiphertext(ENV, "org-dest"), "org-dest")).toThrow(
      BundleRejectedError,
    );
  });
});

describe("importProjectBundle", () => {
  it("stores a new app's env encrypted under the destination org", async () => {
    await importProjectBundle("org-dest", bundle("promote", ENV), "production");
    const app = state.inserts.find((v) => v.name === "web")!;
    expect(app.envContent).not.toContain("hunter2");
    expect(decrypt(app.envContent as string, "org-dest")).toBe(ENV);
  });

  it("re-encrypts env on an existing app under the destination org", async () => {
    state.existingApp = { id: "a1" };
    await importProjectBundle("org-dest", bundle("promote", ENV), "production");
    expect(decrypt(state.updates[0].envContent as string, "org-dest")).toBe(ENV);
  });

  it("leaves an existing app's env alone when the bundle has none", async () => {
    state.existingApp = { id: "a1" };
    await importProjectBundle("org-dest", bundle("promote", null), "production");
    expect(state.updates[0]).not.toHaveProperty("envContent");
  });

  it("drops env from a clone", async () => {
    await importProjectBundle("org-dest", bundle("clone", ENV), "development");
    const app = state.inserts.find((v) => String(v.name).startsWith("web-"))!;
    expect(app.envContent).toBeNull();
  });

  it("rejects the bundle before writing when env is another instance's ciphertext", async () => {
    await expect(
      importProjectBundle("org-dest", bundle("promote", foreignCiphertext(ENV, "org-dest")), "production"),
    ).rejects.toThrow(BundleRejectedError);
    expect(state.inserts.filter((v) => v.name === "web")).toHaveLength(0);
  });
});
