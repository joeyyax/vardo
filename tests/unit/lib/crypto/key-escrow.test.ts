import { describe, it, expect, beforeEach, vi } from "vitest";

// Set before the module loads — encrypt.ts reads the key at call time, but the
// fixtures below are built at import time.
process.env.ENCRYPTION_MASTER_KEY ??= "a".repeat(64);

const { settingsFindFirst, selectMock, insertMock, onConflictDoUpdate } = vi.hoisted(() => ({
  settingsFindFirst: vi.fn(),
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { systemSettings: { findFirst: settingsFindFirst } },
    select: selectMock,
    insert: insertMock,
  },
}));
vi.mock("@/lib/system-settings", () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encrypt, encryptSystem } = await import("@/lib/crypto/encrypt");
const { fingerprintMasterKey } = await import("@/lib/crypto/key-fingerprint");
const { describeKeyEscrow, probeDecryptability, readRecordedFingerprint, reconcileKeyFingerprint } =
  await import("@/lib/crypto/key-escrow");

const RUNNING = fingerprintMasterKey(process.env.ENCRYPTION_MASTER_KEY!);
const FOREIGN = "k1:fedcba9876543210";

/** db.select(...).from(table) returns whichever rows the table was seeded with: apps, settings, targets, peers, channels. */
function seed(
  appRows: unknown[],
  settingRows: unknown[],
  targetRows: unknown[] = [],
  peerRows: unknown[] = [],
  channelRows: unknown[] = [],
) {
  const tables = [appRows, settingRows, targetRows, peerRows, channelRows];
  let call = 0;
  selectMock.mockImplementation(() => ({
    from: () => tables[call++] ?? [],
  }));
}

beforeEach(() => {
  settingsFindFirst.mockReset();
  selectMock.mockReset();
  insertMock.mockReset().mockReturnValue({ values: () => ({ onConflictDoUpdate }) });
  onConflictDoUpdate.mockClear();
  seed([], []);
});

describe("readRecordedFingerprint", () => {
  it("returns nothing when no row exists", async () => {
    settingsFindFirst.mockResolvedValue(undefined);
    expect(await readRecordedFingerprint()).toBeNull();
  });

  it("ignores a row that is not a fingerprint", async () => {
    // A row encrypted with the very key it identifies answers nothing.
    settingsFindFirst.mockResolvedValue({ value: encryptSystem(RUNNING) });
    expect(await readRecordedFingerprint()).toBeNull();
  });

  it("returns a recorded fingerprint", async () => {
    settingsFindFirst.mockResolvedValue({ value: FOREIGN });
    expect(await readRecordedFingerprint()).toBe(FOREIGN);
  });
});

describe("probeDecryptability", () => {
  it("counts only recognised ciphertext", async () => {
    seed(
      [
        { name: "a", orgId: "org-1", envContent: encrypt("A=1", "org-1") },
        { name: "b", orgId: "org-1", envContent: "PLAIN=1" },
        { name: "c", orgId: "org-1", envContent: null },
      ],
      [],
    );
    expect(await probeDecryptability()).toEqual({ encrypted: 1, undecryptable: 0, samples: [] });
  });

  it("names the apps whose env vars will not open", async () => {
    seed(
      [
        { name: "blog", orgId: "org-1", envContent: encrypt("A=1", "someone-else") },
        { name: "shop", orgId: "org-1", envContent: encrypt("B=2", "org-1") },
      ],
      [{ key: "email.token", value: encryptSystem("t") }],
    );
    const probe = await probeDecryptability();
    expect(probe).toMatchObject({ encrypted: 3, undecryptable: 1, samples: ["blog"] });
  });
});

describe("probeDecryptability — backup targets", () => {
  it("counts each encrypted credential and names the target that won't open", async () => {
    seed(
      [],
      [],
      [
        {
          name: "offsite",
          organizationId: "org-1",
          config: { bucket: "b", accessKeyId: encrypt("AK", "org-1"), secretAccessKey: encrypt("SK", "another-org") },
        },
        { name: "system", organizationId: null, config: { host: "h", privateKey: encryptSystem("PEM") } },
        { name: "legacy", organizationId: "org-1", config: { accessKeyId: "AK", secretAccessKey: "SK" } },
        { name: "local", organizationId: "org-1", config: { path: "/backups" } },
      ],
    );
    expect(await probeDecryptability()).toEqual({ encrypted: 3, undecryptable: 1, samples: ["target:offsite"] });
  });
});

describe("probeDecryptability — mesh peers and notification channels", () => {
  function encryptSystemUnderOtherKey(value: string) {
    const running = process.env.ENCRYPTION_MASTER_KEY;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    try {
      return encryptSystem(value);
    } finally {
      process.env.ENCRYPTION_MASTER_KEY = running;
    }
  }

  it("counts outbound tokens and channel secrets and names the ones that won't open", async () => {
    seed(
      [],
      [],
      [],
      [
        { name: "hub", outboundToken: encryptSystem("t1") },
        { name: "spoke", outboundToken: encryptSystemUnderOtherKey("t2") },
        { name: "legacy", outboundToken: "plain" },
        { name: "visible", outboundToken: null },
      ],
      [
        { name: "ops", organizationId: "org-1", config: { url: encrypt("https://h", "org-1"), secret: encrypt("s", "org-2") } },
        { name: "mail", organizationId: "org-1", config: { recipients: ["a@b.c"] } },
      ],
    );
    expect(await probeDecryptability()).toEqual({
      encrypted: 4,
      undecryptable: 2,
      samples: ["peer:spoke", "channel:ops"],
    });
  });
});

describe("reconcileKeyFingerprint", () => {
  it("records the running key on a first boot", async () => {
    settingsFindFirst.mockResolvedValue(undefined);

    const state = await reconcileKeyFingerprint();

    expect(state.status).toEqual({ kind: "ok", fingerprint: RUNNING });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("refuses to certify a key that cannot open what is already here", async () => {
    settingsFindFirst.mockResolvedValue(undefined);
    seed([{ name: "blog", orgId: "org-1", envContent: encrypt("A=1", "someone-else") }], []);

    const state = await reconcileKeyFingerprint();

    expect(state.status.kind).toBe("unrecorded");
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("reports a restored-onto-a-new-host database as a mismatch", async () => {
    settingsFindFirst.mockResolvedValue({ value: FOREIGN });

    const state = await reconcileKeyFingerprint();

    expect(state.status).toEqual({ kind: "mismatch", recorded: FOREIGN, running: RUNNING });
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("does not probe when no key is configured", async () => {
    const key = process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ENCRYPTION_MASTER_KEY;
    try {
      settingsFindFirst.mockResolvedValue({ value: FOREIGN });
      const state = await reconcileKeyFingerprint();
      expect(state.status).toEqual({ kind: "unconfigured" });
      expect(selectMock).not.toHaveBeenCalled();
    } finally {
      process.env.ENCRYPTION_MASTER_KEY = key;
    }
  });
});

describe("describeKeyEscrow", () => {
  const noProbe = { encrypted: 0, undecryptable: 0, samples: [] };

  it("leads with the missing key rather than the decrypt failures it causes", () => {
    expect(
      describeKeyEscrow({ status: { kind: "unconfigured" }, probe: { encrypted: 9, undecryptable: 9, samples: [] } }),
    ).toMatchObject({ severity: "warning" });
  });

  it("treats undecryptable rows as critical whatever the fingerprints say", () => {
    expect(
      describeKeyEscrow({
        status: { kind: "ok", fingerprint: RUNNING },
        probe: { encrypted: 4, undecryptable: 2, samples: ["blog"] },
      }),
    ).toMatchObject({ severity: "critical" });
  });

  it("treats a fingerprint mismatch as critical", () => {
    expect(
      describeKeyEscrow({ status: { kind: "mismatch", recorded: FOREIGN, running: RUNNING }, probe: noProbe }),
    ).toMatchObject({ severity: "critical" });
  });

  it("is quiet when the key matches", () => {
    expect(
      describeKeyEscrow({ status: { kind: "ok", fingerprint: RUNNING }, probe: noProbe }),
    ).toMatchObject({ severity: "ok" });
  });
});
