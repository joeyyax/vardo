// The startup step that encrypts credentials stored before encryption on write.

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "d".repeat(64);

type Row = Record<string, unknown> & { id: string };

const { db, rows, settingRows } = vi.hoisted(() => {
  const rows: Record<string, Row[]> = { backup_target: [], mesh_peer: [], notification_channel: [], org_env_var: [], app: [] };
  const settingRows: { key: string; value: string }[] = [];
  const nameOf = (table: object) => (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
  // eq() and and() are mocked to plain data, so the row id is read off the where clause.
  const idOf = (where: unknown) =>
    (where as { col: { name: string }; val: string }[]).find((c) => c.col.name === "id")!.val;
  const db = {
    select: () => ({
      from: (table: object) => {
        const copy = () => rows[nameOf(table)].map((r) => structuredClone(r));
        return Object.assign(Promise.resolve(copy()), { where: async () => copy() });
      },
    }),
    query: {
      systemSettings: {
        findFirst: vi.fn(async () => settingRows[0]),
      },
    },
    update: vi.fn((table: object) => ({
      set: (data: Record<string, unknown>) => ({
        where: (where: unknown) => {
          const name = nameOf(table);
          if (name === "system_settings") {
            settingRows[0].value = data.value as string;
            return Promise.resolve();
          }
          const row = rows[name].find((r) => r.id === idOf(where))!;
          Object.assign(row, data);
          return { returning: async () => [{ id: row.id }] };
        },
      }),
    })),
  };
  return { db, rows, settingRows };
});

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conds: unknown[]) => conds,
  isNotNull: () => undefined,
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/system-settings", () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encrypt, encryptSystem, decrypt, decryptSystem, isEncrypted } = await import("@/lib/crypto/encrypt");
const { canEncryptStoredCredentials, encryptStoredCredentials } = await import(
  "@/lib/crypto/encrypt-stored-credentials"
);

const REGISTRY = JSON.stringify({ "ghcr.io": { username: "u", password: "ghp_token" } });

const targetRows = rows.backup_target as unknown as { id: string; organizationId: string | null; config: Record<string, unknown> }[];
const peerRows = rows.mesh_peer as unknown as { id: string; outboundToken: string | null }[];
const channelRows = rows.notification_channel as unknown as { id: string; organizationId: string; config: Record<string, unknown> }[];
const envRows = rows.org_env_var as unknown as { id: string; organizationId: string; value: string }[];
const appRows = rows.app as unknown as { id: string; organizationId: string; gitCredentials: string | null }[];

function seed() {
  for (const list of Object.values(rows)) list.length = 0;
  settingRows.length = 0;
  peerRows.push({ id: "hub", outboundToken: "raw-hub-token" }, { id: "visible", outboundToken: null });
  channelRows.push(
    { id: "hook", organizationId: "org-1", config: { url: "https://hooks.example/x", secret: "whsec" } },
    { id: "slack", organizationId: "org-2", config: { webhookUrl: "https://hooks.slack.com/T/B/x" } },
    { id: "mail", organizationId: "org-1", config: { recipients: ["a@example.com"] } },
  );
  targetRows.push(
    { id: "plain-org", organizationId: "org-1", config: { bucket: "b", region: "r", accessKeyId: "AK", secretAccessKey: "SK" } },
    { id: "plain-system", organizationId: null, config: { host: "h", username: "u", path: "/p", privateKey: "PEM" } },
    { id: "local", organizationId: "org-1", config: { path: "/backups" } },
  );
  settingRows.push({ key: "registry_credentials", value: REGISTRY });
  envRows.push(
    { id: "plain-env", organizationId: "org-1", value: "info" },
    { id: "sealed-env", organizationId: "org-2", value: encrypt("hunter2", "org-2") },
  );
  appRows.push(
    { id: "moved-app", organizationId: "org-1", gitCredentials: "deploy:tok3n-value" },
    { id: "sealed-app", organizationId: "org-2", gitCredentials: encrypt("bot:pw", "org-2") },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("encryptStoredCredentials", () => {
  it("encrypts plaintext target credentials under the owning key", async () => {
    const result = await encryptStoredCredentials();

    expect(result.targets).toBe(2);
    const [org, system, local] = targetRows;
    expect(decrypt(org.config.secretAccessKey as string, "org-1")).toBe("SK");
    expect(decrypt(org.config.accessKeyId as string, "org-1")).toBe("AK");
    expect(org.config.bucket).toBe("b");
    expect(decryptSystem(system.config.privateKey as string)).toBe("PEM");
    expect(local.config).toEqual({ path: "/backups" });
  });

  it("encrypts plaintext registry credentials", async () => {
    const result = await encryptStoredCredentials();

    expect(result.settings).toBe(1);
    expect(isEncrypted(settingRows[0].value)).toBe(true);
    expect(decryptSystem(settingRows[0].value)).toBe(REGISTRY);
  });

  it("leaves ciphertext alone on a rerun", async () => {
    await encryptStoredCredentials();
    const after = JSON.stringify({ rows, settingRows });
    db.update.mockClear();

    const rerun = await encryptStoredCredentials();

    expect(rerun).toEqual({ targets: 0, settings: 0, peers: 0, channels: 0, orgEnvVars: 0, appGitCredentials: 0 });
    expect(db.update).not.toHaveBeenCalled();
    expect(JSON.stringify({ rows, settingRows })).toBe(after);
  });

  it("encrypts only the fields still in plaintext", async () => {
    const sealed = encrypt("SK", "org-1");
    targetRows.splice(1);
    targetRows[0].config.secretAccessKey = sealed;

    await encryptStoredCredentials();

    expect(targetRows[0].config.secretAccessKey).toBe(sealed);
    expect(decrypt(targetRows[0].config.accessKeyId as string, "org-1")).toBe("AK");
  });
});

describe("encryptStoredCredentials — mesh peers and notification channels", () => {
  it("encrypts plaintext outbound tokens under the system key", async () => {
    const result = await encryptStoredCredentials();

    expect(result.peers).toBe(1);
    expect(decryptSystem(peerRows[0].outboundToken!)).toBe("raw-hub-token");
    expect(peerRows[1].outboundToken).toBeNull();
  });

  it("leaves an already encrypted outbound token alone", async () => {
    const sealed = encryptSystem("raw-hub-token");
    peerRows[0].outboundToken = sealed;

    const result = await encryptStoredCredentials();

    expect(result.peers).toBe(0);
    expect(peerRows[0].outboundToken).toBe(sealed);
  });

  it("encrypts channel URLs and secrets under the owning org's key", async () => {
    const result = await encryptStoredCredentials();

    expect(result.channels).toBe(2);
    const [hook, slack, mail] = channelRows;
    expect(decrypt(hook.config.url as string, "org-1")).toBe("https://hooks.example/x");
    expect(decrypt(hook.config.secret as string, "org-1")).toBe("whsec");
    expect(decrypt(slack.config.webhookUrl as string, "org-2")).toBe("https://hooks.slack.com/T/B/x");
    expect(mail.config).toEqual({ recipients: ["a@example.com"] });
  });
});

describe("encryptStoredCredentials — org env vars", () => {
  it("encrypts plaintext values under the owning org's key", async () => {
    const sealed = envRows[1].value;

    const result = await encryptStoredCredentials();

    expect(result.orgEnvVars).toBe(1);
    expect(decrypt(envRows[0].value, "org-1")).toBe("info");
    expect(envRows[1].value).toBe(sealed);
  });
});

describe("encryptStoredCredentials — app git credentials", () => {
  it("encrypts credentials the migration moved out of git_url, once", async () => {
    const sealed = appRows[1].gitCredentials;

    const result = await encryptStoredCredentials();

    expect(result.appGitCredentials).toBe(1);
    expect(decrypt(appRows[0].gitCredentials!, "org-1")).toBe("deploy:tok3n-value");
    expect(appRows[1].gitCredentials).toBe(sealed);
    expect((await encryptStoredCredentials()).appGitCredentials).toBe(0);
  });
});

describe("canEncryptStoredCredentials", () => {
  const probe = { encrypted: 0, undecryptable: 0, samples: [] };

  it("runs only under a key this database trusts", () => {
    expect(canEncryptStoredCredentials({ status: { kind: "ok", fingerprint: "k1:x" }, probe })).toBe(true);
    expect(canEncryptStoredCredentials({ status: { kind: "mismatch", recorded: "k1:a", running: "k1:b" }, probe })).toBe(false);
    expect(canEncryptStoredCredentials({ status: { kind: "unrecorded", running: "k1:b" }, probe })).toBe(false);
    expect(canEncryptStoredCredentials({ status: { kind: "unconfigured" }, probe })).toBe(false);
    expect(
      canEncryptStoredCredentials({ status: { kind: "ok", fingerprint: "k1:x" }, probe: { ...probe, undecryptable: 1 } }),
    ).toBe(false);
    expect(canEncryptStoredCredentials(null)).toBe(false);
  });
});
