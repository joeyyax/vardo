import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// Loki runs with auth_enabled, so a read that reaches it must name a tenant and
// a read that can't name one must not reach it at all. Both halves are checked
// against a real server, because the header only counts if it goes on the wire.

import {
  queryInstant,
  queryRange,
  requireTenant,
  tailLogs,
  tenantHeaders,
} from "@/lib/logging/client";
import { readLogHistory, readLokiHistory } from "@/lib/logging/history";

type Captured = { headers: IncomingMessage["headers"]; url: string };

let server: Server;
let captured: Captured[];
let sockets: Socket[];
const originalUrl = process.env.LOKI_URL;

function emptyResult(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "success", data: { resultType: "streams", result: [] } }));
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Complete the upgrade so the client closes cleanly instead of retrying a broken socket. */
function handshake(req: IncomingMessage, socket: Socket) {
  const accept = createHash("sha1")
    .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

beforeEach(async () => {
  captured = [];
  sockets = [];
  server = createServer((req, res) => {
    captured.push({ headers: req.headers, url: req.url ?? "" });
    emptyResult(res);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    captured.push({ headers: req.headers, url: req.url ?? "" });
    sockets.push(socket);
    handshake(req, socket);
    socket.end(Buffer.from([0x88, 0x00])); // close frame
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.LOKI_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (originalUrl === undefined) delete process.env.LOKI_URL;
  else process.env.LOKI_URL = originalUrl;
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("requireTenant", () => {
  it("returns the organization it was given", () => {
    expect(requireTenant("org-abc")).toBe("org-abc");
  });

  it("refuses a blank organization", () => {
    expect(() => requireTenant("")).toThrow(/organization id/);
    expect(() => requireTenant("   ")).toThrow(/organization id/);
    expect(() => requireTenant(undefined as unknown as string)).toThrow(/organization id/);
  });

  it("names the tenant in the header Loki reads", () => {
    expect(tenantHeaders("org-abc")).toEqual({ "X-Scope-OrgID": "org-abc" });
  });
});

describe("Loki reads carry the organization", () => {
  it("sends the tenant header on a range query", async () => {
    await queryRange({ query: '{project="app"}', organizationId: "org-abc" });
    expect(captured).toHaveLength(1);
    expect(captured[0].headers["x-scope-orgid"]).toBe("org-abc");
  });

  it("sends the tenant header on an instant query", async () => {
    await queryInstant("sum(count_over_time({project_id=~\".+\"}[60s]))", "org-abc");
    expect(captured).toHaveLength(1);
    expect(captured[0].headers["x-scope-orgid"]).toBe("org-abc");
  });

  it("sends the tenant header on the tail websocket", async () => {
    const controller = new AbortController();
    await tailLogs(
      { query: '{project="app"}', organizationId: "org-abc" },
      () => {},
      controller.signal,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].headers["x-scope-orgid"]).toBe("org-abc");
  });
});

describe("a read with no organization fails closed", () => {
  it("does not fall back to querying every tenant", async () => {
    await expect(
      queryRange({ query: '{project="app"}', organizationId: "" }),
    ).rejects.toThrow(/organization id/);
    await expect(queryInstant("sum(rate({a=\"b\"}[1m]))", "")).rejects.toThrow(/organization id/);
    await expect(
      tailLogs({ query: '{project="app"}', organizationId: "" }, () => {}, new AbortController().signal),
    ).rejects.toThrow(/organization id/);
    expect(captured).toEqual([]);
  });

  it("stops the history reader before it reaches Loki", async () => {
    await expect(
      readLokiHistory({ project: "app", organizationId: " ", tail: 10 }),
    ).rejects.toThrow(/organization id/);
    expect(captured).toEqual([]);
  });

  it("stops the backfill rather than silently reading the container instead", async () => {
    await expect(
      readLogHistory({ project: "app", organizationId: "", environment: "production", tail: 10 }),
    ).rejects.toThrow(/organization id/);
    expect(captured).toEqual([]);
  });
});
