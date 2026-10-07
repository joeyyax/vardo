// OAuth tokens stored before Better Auth encrypted them are sealed on startup in
// a format its own decrypt reads back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

type Row = { id: string; accessToken: string | null; refreshToken: string | null };

const { rows, update } = vi.hoisted(() => {
  const rows: Row[] = [];
  const update = vi.fn();
  return { rows, update };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => rows.map((r) => ({ ...r })) }) }),
    update: () => ({
      set: (data: Partial<Row>) => ({
        where: (where: { val: string }[]) => {
          update(data);
          const row = rows.find((r) => r.id === where[0].val)!;
          Object.assign(row, data);
          return { returning: async () => [{ id: row.id }] };
        },
      }),
    }),
  },
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conds: unknown[]) => conds.filter(Boolean),
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encryptStoredOAuthTokens, isOAuthTokenCiphertext } = await import("@/lib/auth/oauth-tokens");

const SECRET = "better-auth-test-secret-0123456789abcdef";
const LEGACY_HEX = "0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
  rows.length = 0;
  update.mockClear();
});

describe("isOAuthTokenCiphertext", () => {
  it("recognises what Better Auth writes", async () => {
    expect(isOAuthTokenCiphertext(await symmetricEncrypt({ key: SECRET, data: "gho_x" }))).toBe(true);
    expect(isOAuthTokenCiphertext("$ba$1$abcd")).toBe(true);
  });

  it("treats GitHub tokens as plaintext, including 40-char hex ones", () => {
    expect(isOAuthTokenCiphertext("gho_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(false);
    expect(isOAuthTokenCiphertext(LEGACY_HEX)).toBe(false);
  });
});

describe("encryptStoredOAuthTokens", () => {
  it("encrypts plaintext tokens so Better Auth can read them back", async () => {
    rows.push({ id: "a", accessToken: "gho_access", refreshToken: "ghr_refresh" });

    expect(await encryptStoredOAuthTokens(SECRET)).toBe(1);

    expect(await symmetricDecrypt({ key: SECRET, data: rows[0].accessToken! })).toBe("gho_access");
    expect(await symmetricDecrypt({ key: SECRET, data: rows[0].refreshToken! })).toBe("ghr_refresh");
  });

  it("encrypts a legacy hex token Better Auth would misread as ciphertext", async () => {
    rows.push({ id: "a", accessToken: LEGACY_HEX, refreshToken: null });

    await encryptStoredOAuthTokens(SECRET);

    expect(rows[0].refreshToken).toBeNull();
    expect(await symmetricDecrypt({ key: SECRET, data: rows[0].accessToken! })).toBe(LEGACY_HEX);
  });

  it("leaves encrypted rows alone on a rerun", async () => {
    rows.push({ id: "a", accessToken: "gho_access", refreshToken: null });
    await encryptStoredOAuthTokens(SECRET);
    const after = { ...rows[0] };
    update.mockClear();

    expect(await encryptStoredOAuthTokens(SECRET)).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(rows[0]).toEqual(after);
  });
});
