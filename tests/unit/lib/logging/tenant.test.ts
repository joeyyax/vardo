import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// VictoriaLogs separates organizations by AccountID, so every read that reaches
// it must carry its organization's account, and a read that can't name one must
// not reach it at all. Both halves are checked against a real HTTP server,
// because the header only counts if it goes on the wire.

const ACCOUNTS: Record<string, number> = { "org-abc": 41, "org-xyz": 42 };

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizations: {
        findFirst: vi.fn(async (opts: { where: unknown }) => {
          const id = orgIdOf(opts.where);
          return id in ACCOUNTS ? { logAccountId: ACCOUNTS[id] } : undefined;
        }),
      },
    },
  },
}));

/** The org id a drizzle `eq(organizations.id, x)` compares against. */
function orgIdOf(where: unknown): string {
  const chunks = (where as { queryChunks?: unknown[] }).queryChunks ?? [];
  const param = chunks.find((c) => (c as { value?: unknown })?.value !== undefined && typeof (c as { value: unknown }).value === "string") as { value: string } | undefined;
  return param?.value ?? "";
}

import { accountHeaders, logAccountId, requireAccount } from "@/lib/logging/account";
import { queryFieldValues, queryHits, queryLogs, queryStats, tailLogs } from "@/lib/logging/victorialogs";
import { readLogHistory, readStoredHistory } from "@/lib/logging/history";

type Captured = { headers: IncomingMessage["headers"]; url: string };

let server: Server;
let captured: Captured[];
const originalUrl = process.env.VICTORIALOGS_URL;

beforeEach(async () => {
  captured = [];
  server = createServer((req, res) => {
    captured.push({ headers: req.headers, url: req.url ?? "" });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("stats_query")) res.end(JSON.stringify({ status: "success", data: { result: [] } }));
      else if (req.url?.includes("hits")) res.end(JSON.stringify({ hits: [] }));
      else if (req.url?.includes("field_values")) res.end(JSON.stringify({ values: [] }));
      else res.end("");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.VICTORIALOGS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (originalUrl === undefined) delete process.env.VICTORIALOGS_URL;
  else process.env.VICTORIALOGS_URL = originalUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("requireAccount", () => {
  it("accepts an organization's account", () => {
    expect(requireAccount(41)).toBe(41);
  });

  it("refuses the unassigned tenant and anything that isn't an AccountID", () => {
    for (const bad of [0, -1, 1.5, 2 ** 32, NaN, null, undefined]) {
      expect(() => requireAccount(bad as number)).toThrow(/log account/);
    }
  });

  it("names the account in the headers VictoriaLogs reads", () => {
    expect(accountHeaders(41)).toEqual({ AccountID: "41", ProjectID: "0" });
  });
});

describe("logAccountId", () => {
  it("returns each organization's own account", async () => {
    expect(await logAccountId("org-abc")).toBe(41);
    expect(await logAccountId("org-xyz")).toBe(42);
  });

  it("refuses a blank or unknown organization", async () => {
    await expect(logAccountId("")).rejects.toThrow(/organization id/);
    await expect(logAccountId("   ")).rejects.toThrow(/organization id/);
    await expect(logAccountId("org-gone")).rejects.toThrow(/log account/);
  });
});

const READS: [string, (org: string) => Promise<unknown>][] = [
  ["a query", (org) => queryLogs({ query: "*", organizationId: org })],
  ["a stats query", (org) => queryStats("* | stats count() n", org)],
  ["a hits query", (org) => queryHits({ query: "*", organizationId: org, start: "1h", step: "5m", fields: ["compose_service", "vardo.project"] })],
  ["a field values query", (org) => queryFieldValues({ query: "*", organizationId: org, field: "compose_service" })],
  ["a live tail", (org) => tailLogs({ query: "*", organizationId: org }, () => {}, new AbortController().signal)],
  ["the history reader", (org) => readStoredHistory({ project: "app", organizationId: org, tail: 10 })],
];

describe("every read carries its organization's account", () => {
  for (const [what, read] of READS) {
    it(`sends the AccountID on ${what}`, async () => {
      await read("org-abc");
      expect(captured.length).toBeGreaterThan(0);
      for (const req of captured) {
        expect(req.headers.accountid).toBe("41");
        expect(req.headers.projectid).toBe("0");
      }
    });
  }

  it("never sends one organization's account for another", async () => {
    await queryLogs({ query: "*", organizationId: "org-abc" });
    await queryLogs({ query: "*", organizationId: "org-xyz" });
    expect(captured.map((c) => c.headers.accountid)).toEqual(["41", "42"]);
  });
});

describe("a read with no organization fails closed", () => {
  for (const [what, read] of READS) {
    it(`stops ${what} before it reaches VictoriaLogs`, async () => {
      await expect(read("")).rejects.toThrow(/organization id/);
      await expect(read("org-gone")).rejects.toThrow(/log account/);
      expect(captured).toEqual([]);
    });
  }

  it("stops the backfill rather than silently reading the container instead", async () => {
    await expect(
      readLogHistory({ project: "app", projectId: "a1", organizationId: "", environment: "production", tail: 10 }),
    ).rejects.toThrow(/organization id/);
    expect(captured).toEqual([]);
  });
});
