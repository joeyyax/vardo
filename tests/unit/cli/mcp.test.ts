import { describe, it, expect, vi } from "vitest";
import { callTool, CallError, listTools, parseSse, rpc } from "@/packages/cli/src/mcp";

const target = { url: "https://vardo.example.com", token: "secret" };

function sse(...messages: unknown[]) {
  return messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
}

function fakeFetch(body: string, init: { status?: number; type?: string } = {}) {
  return vi.fn(async () => new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/event-stream" } }));
}

describe("parseSse", () => {
  it("reads data lines from each event", () => {
    expect(parseSse(sse({ id: 1, result: {} }, { id: 2 }))).toEqual([{ id: 1, result: {} }, { id: 2 }]);
  });

  it("joins multi-line data and handles CRLF and no space after the colon", () => {
    expect(parseSse('event: message\r\ndata:{"a":\r\ndata: 1}\r\n\r\n')).toEqual([{ a: 1 }]);
  });

  it("skips comments and empty events", () => {
    expect(parseSse(": ping\n\n\n\ndata: {}\n\n")).toEqual([{}]);
  });
});

describe("rpc", () => {
  it("posts JSON-RPC with the bearer token and both accept types", async () => {
    const f = fakeFetch(sse({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "vardo_doctor" }] } }));
    expect(await listTools(target, { fetch: f })).toEqual([{ name: "vardo_doctor" }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vardo.example.com/api/mcp");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers.Accept).toBe("application/json, text/event-stream");
    expect(JSON.parse(init.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  });

  it("reads a plain JSON response", async () => {
    const f = fakeFetch(JSON.stringify({ id: 1, result: { content: [] } }), { type: "application/json" });
    expect(await callTool(target, "vardo_doctor", {}, { fetch: f })).toEqual({ content: [] });
  });

  it("sends tools/call with the arguments", async () => {
    const f = fakeFetch(sse({ id: 1, result: { content: [] } }));
    await callTool(target, "vardo_list_apps", { limit: 2 }, { fetch: f });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.params).toEqual({ name: "vardo_list_apps", arguments: { limit: 2 } });
  });

  it("explains a rejected token", async () => {
    await expect(rpc(target, "tools/list", {}, { fetch: fakeFetch('{"error":"Unauthorized"}', { status: 401 }) })).rejects.toThrow(
      "vardo.example.com rejected the token. Run `vardo login https://vardo.example.com` again.",
    );
  });

  it("surfaces other HTTP errors", async () => {
    await expect(rpc(target, "tools/list", {}, { fetch: fakeFetch('{"error":"Plugin off"}', { status: 404 }) })).rejects.toThrow(
      "vardo.example.com answered 404: Plugin off",
    );
  });

  it("surfaces JSON-RPC errors", async () => {
    const f = fakeFetch(sse({ id: 1, error: { code: -32602, message: "Invalid params" } }));
    await expect(rpc(target, "tools/call", {}, { fetch: f })).rejects.toThrow("Invalid params");
  });

  it("wraps network failures", async () => {
    const f = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { message: "getaddrinfo ENOTFOUND" } });
    });
    const err = (await rpc(target, "tools/list", {}, { fetch: f }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(CallError);
    expect(err.message).toBe("Can't reach vardo.example.com: getaddrinfo ENOTFOUND");
  });

  it("rejects an unreadable body", async () => {
    await expect(rpc(target, "tools/list", {}, { fetch: fakeFetch("data: {nope\n\n") })).rejects.toThrow("can't read");
  });
});
