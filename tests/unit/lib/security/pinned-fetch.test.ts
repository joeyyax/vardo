import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, default: { ...actual, lookup: lookupMock }, lookup: lookupMock };
});

const { pinnedFetch, guardedLookup } = await import("@/lib/security/pinned-fetch");
const { BlockedUrlError } = await import("@/lib/security/ssrf");

/** Makes the mocked resolver answer every lookup with these addresses. */
function resolveTo(...addresses: string[]) {
  lookupMock.mockImplementation((_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => {
    cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  });
}

function lookupOnce(allowPrivate: boolean, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    guardedLookup(allowPrivate)(host, {}, (err, address) => (err ? reject(err) : resolve(address as string)));
  });
}

let server: http.Server;
let port: number;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "text/plain", "x-echo-method": req.method ?? "" });
      res.end(`got:${body}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  lookupMock.mockReset();
  hits = 0;
});

describe("guardedLookup", () => {
  it("passes a public address through", async () => {
    resolveTo("93.184.216.34");
    await expect(lookupOnce(false, "example.com")).resolves.toBe("93.184.216.34");
  });

  it("refuses a name that resolves to the metadata address", async () => {
    resolveTo("169.254.169.254");
    await expect(lookupOnce(false, "metadata.attacker.test")).rejects.toThrow(/metadata/);
  });

  it("refuses when any record is private", async () => {
    resolveTo("93.184.216.34", "10.0.0.19");
    await expect(lookupOnce(false, "mixed.attacker.test")).rejects.toThrow(BlockedUrlError);
  });

  it("lets an allowlisted host resolve privately", async () => {
    resolveTo("10.0.0.19");
    await expect(lookupOnce(true, "internal.example.com")).resolves.toBe("10.0.0.19");
  });
});

describe("pinnedFetch", () => {
  it("refuses at connect time when the name rebinds to loopback", async () => {
    resolveTo("127.0.0.1");
    await expect(pinnedFetch(new URL(`http://rebind.attacker.test:${port}/`))).rejects.toThrow(/loopback/);
    expect(hits).toBe(0);
  });

  it("reaches an allowlisted host and returns status, headers and body", async () => {
    resolveTo("127.0.0.1");
    const res = await pinnedFetch(new URL(`http://internal.test:${port}/hook`), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      allowPrivate: true,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-echo-method")).toBe("POST");
    expect(await res.text()).toBe("got:{}");
    expect(hits).toBe(1);
  });
});
