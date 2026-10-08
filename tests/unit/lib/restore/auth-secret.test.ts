import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { gzipSync } from "zlib";
import { join } from "path";
import { tmpdir } from "os";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { checkAuthSecret, checkDumpAuthSecret, findTwoFactorSecret } from "@/lib/restore/auth-secret";

const authContext = vi.hoisted(() => ({ secretConfig: "" as unknown }));
vi.mock("@/lib/auth", () => ({ auth: { $context: Promise.resolve(authContext) } }));

async function* linesOf(text: string) {
  for (const line of text.split("\n")) yield line;
}

/** Shaped like pg_dump's plain output for this schema. */
function dump(secret: string | null): string {
  const rows = secret === null ? "" : `t1\t${secret}\tcodes\tu1\tt\t0\t\\N\n`;
  return [
    "COPY public.user (id, name) FROM stdin;",
    "u1\tA",
    "\\.",
    "COPY public.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count, locked_until) FROM stdin;",
    `${rows}\\.`,
  ].join("\n");
}

describe("findTwoFactorSecret", () => {
  it("reads the secret column of the first two_factor row", async () => {
    expect(await findTwoFactorSecret(linesOf(dump("$ba$1$abcdef")))).toBe("$ba$1$abcdef");
  });

  it("returns null when no one uses two-factor", async () => {
    expect(await findTwoFactorSecret(linesOf(dump(null)))).toBeNull();
  });
});

describe("checkAuthSecret", () => {
  const versioned = (secret: string) => ({ keys: new Map([[1, secret]]), currentVersion: 1 });

  it("matches a secret encrypted with the same BETTER_AUTH_SECRET", async () => {
    const stored = await symmetricEncrypt({ key: versioned("old-instance-secret-0123456789abcdef"), data: "TOTPSEED" });
    const check = await checkAuthSecret(stored, (data) =>
      symmetricDecrypt({ key: versioned("old-instance-secret-0123456789abcdef"), data }),
    );
    expect(check.kind).toBe("match");
  });

  it("flags a different BETTER_AUTH_SECRET", async () => {
    const stored = await symmetricEncrypt({ key: versioned("old-instance-secret-0123456789abcdef"), data: "TOTPSEED" });
    const check = await checkAuthSecret(stored, (data) =>
      symmetricDecrypt({ key: versioned("fresh-install-secret-0123456789abcdef"), data }),
    );
    expect(check.kind).toBe("mismatch");
  });

  it("has nothing to check without a two-factor row", async () => {
    expect((await checkAuthSecret(null, async () => "x")).kind).toBe("none");
  });
});

describe("checkDumpAuthSecret", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("checks a gzipped dump against the running auth secret", async () => {
    const old = "old-instance-secret-0123456789abcdef";
    const stored = await symmetricEncrypt({ key: old, data: "TOTPSEED" });
    dir = await mkdtemp(join(tmpdir(), "vardo-auth-secret-"));
    const path = join(dir, "dump.gz");
    await writeFile(path, gzipSync(dump(stored)));

    authContext.secretConfig = old;
    expect((await checkDumpAuthSecret(path)).kind).toBe("match");

    authContext.secretConfig = "fresh-install-secret-0123456789abcdef";
    expect((await checkDumpAuthSecret(path)).kind).toBe("mismatch");
  });
});
