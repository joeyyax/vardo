import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

// The settings page loads org env vars into a textarea and saves the whole
// thing back. Secrets must survive that round trip.

type Row = { id: string; organizationId: string; key: string; value: string; isSecret: boolean | null };

const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (col: { name: string }, val: unknown) => ({ col: col.name, val }),
  and: (...conds: unknown[]) => conds,
}));

vi.mock("@/lib/db", () => {
  const db = {
    query: { orgEnvVars: { findMany: vi.fn(async () => rows.map((r) => ({ ...r }))) } },
    insert: () => ({
      values: (v: Row) => {
        rows.push({ ...v, isSecret: v.isSecret ?? false });
        return { returning: async () => [{ ...v }] };
      },
    }),
    update: () => ({
      set: (data: Partial<Row>) => ({
        where: async (conds: { col: string; val: string }[]) => {
          const id = conds.find((c) => c.col === "id")!.val;
          Object.assign(rows.find((r) => r.id === id)!, data);
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(db),
  };
  return { db };
});
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({ session: { user: { id: "u1" } } }),
}));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: never[]) => unknown) => handler,
}));

import { GET, PUT } from "@/app/api/v1/organizations/[orgId]/env-vars/route";
import { encrypt, decrypt, isEncrypted } from "@/lib/crypto/encrypt";
import { orgEnvToContent } from "@/lib/env/org-env-content";

const URL = "http://localhost/api/v1/organizations/org-1/env-vars";
const params = { params: Promise.resolve({ orgId: "org-1" }) };

async function load(): Promise<string> {
  const res = await GET(new NextRequest(URL), params);
  return orgEnvToContent((await res.json()).envVars);
}

async function save(content: string) {
  const res = await PUT(new NextRequest(URL, { method: "PUT", body: JSON.stringify({ content }) }), params);
  return res.json();
}

const valueOf = (key: string) => decrypt(rows.find((r) => r.key === key)!.value, "org-1");

beforeEach(() => {
  rows.length = 0;
  rows.push(
    { id: "s", organizationId: "org-1", key: "API_TOKEN", value: encrypt("hunter2", "org-1"), isSecret: true },
    { id: "p", organizationId: "org-1", key: "LOG_LEVEL", value: encrypt("info", "org-1"), isSecret: false },
  );
});

describe("org env vars round trip", () => {
  it("never sends a secret value to the editor", async () => {
    expect(await load()).toBe("API_TOKEN=••••••••\nLOG_LEVEL=info");
  });

  it("keeps the secret when the content is saved unchanged", async () => {
    const result = await save(await load());

    expect(result).toEqual({ created: 0, updated: 0 });
    expect(valueOf("API_TOKEN")).toBe("hunter2");
  });

  it("keeps the secret when a non-secret is edited", async () => {
    const result = await save((await load()).replace("LOG_LEVEL=info", "LOG_LEVEL=debug"));

    expect(result).toEqual({ created: 0, updated: 1 });
    expect(valueOf("API_TOKEN")).toBe("hunter2");
    expect(valueOf("LOG_LEVEL")).toBe("debug");
  });

  it("keeps the secret when an older editor sends it back blank", async () => {
    await save("API_TOKEN=\nLOG_LEVEL=info");

    expect(valueOf("API_TOKEN")).toBe("hunter2");
  });

  it("replaces a secret with a typed value", async () => {
    await save("API_TOKEN=rotated");

    expect(valueOf("API_TOKEN")).toBe("rotated");
    expect(rows.find((r) => r.key === "API_TOKEN")!.isSecret).toBe(true);
  });

  it("stores a new var encrypted", async () => {
    const result = await save(`${await load()}\nSMTP_HOST=smtp.example.com`);

    expect(result).toEqual({ created: 1, updated: 0 });
    const row = rows.find((r) => r.key === "SMTP_HOST")!;
    expect(isEncrypted(row.value)).toBe(true);
    expect(decrypt(row.value, "org-1")).toBe("smtp.example.com");
  });

  it("never stores the mask as a new value", async () => {
    await save("COPIED=••••••••");

    expect(rows.find((r) => r.key === "COPIED")).toBeUndefined();
  });

  it("keeps vars left out of the content", async () => {
    await save("LOG_LEVEL=info");

    expect(rows.map((r) => r.key)).toEqual(["API_TOKEN", "LOG_LEVEL"]);
  });

  it("reads and encrypts a legacy plaintext row", async () => {
    rows[1].value = "warn";

    expect(await load()).toBe("API_TOKEN=••••••••\nLOG_LEVEL=warn");

    await save(await load());
    expect(isEncrypted(rows[1].value)).toBe(true);
    expect(valueOf("LOG_LEVEL")).toBe("warn");
  });
});
