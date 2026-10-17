import { describe, expect, it } from "vitest";
import { MAX_HEADERS, MAX_HEADER_VALUE, basicAuthHeader, headersProblem, sendableHeaders } from "@/lib/uptime/core";

describe("headersProblem", () => {
  it("accepts ordinary headers", () => {
    expect(headersProblem([{ name: "Authorization", value: "Bearer abc" }, { name: "X-Health-Token", value: "t0k3n" }])).toBeNull();
  });

  it.each(["Host", "connection", "Transfer-Encoding", "Upgrade", "Keep-Alive", "TE", "Content-Length", "Cache-Control"])("blocks %s", (name) => {
    expect(headersProblem([{ name, value: "x" }])).toMatch(/can't be set/);
  });

  it("refuses bad names, repeats, empty and multiline values", () => {
    expect(headersProblem([{ name: "Bad Name", value: "x" }])).toMatch(/valid header name/);
    expect(headersProblem([{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }])).toMatch(/twice/);
    expect(headersProblem([{ name: "X-A", value: "" }])).toMatch(/must be/);
    expect(headersProblem([{ name: "X-A", value: "a\r\nX-B: b" }])).toMatch(/must be/);
  });

  it("caps count and size", () => {
    expect(headersProblem(Array.from({ length: MAX_HEADERS + 1 }, (_, i) => ({ name: `X-${i}`, value: "v" })))).toMatch(/at most/);
    expect(headersProblem([{ name: "X-A", value: "v".repeat(MAX_HEADER_VALUE + 1) }])).toMatch(/must be/);
    expect(headersProblem(Array.from({ length: 5 }, (_, i) => ({ name: `X-${i}`, value: "v".repeat(MAX_HEADER_VALUE) })))).toMatch(/too large/);
  });

  it("never puts a value in a reason", () => {
    expect(headersProblem([{ name: "Host", value: "secret-value" }])).not.toContain("secret-value");
    expect(headersProblem([{ name: "X-A", value: "secret-value\n" }])).not.toContain("secret-value");
  });
});

describe("basicAuthHeader", () => {
  it("encodes the pair", () => expect(basicAuthHeader("me", "pw")).toEqual({ name: "Authorization", value: "Basic bWU6cHc=" }));
});

describe("sendableHeaders", () => {
  it("drops a whole set that carries a blocked header", () => {
    expect(sendableHeaders({ "X-A": "1" })).toEqual({ "X-A": "1" });
    expect(sendableHeaders({ "X-A": "1", Host: "evil" })).toEqual({});
    expect(sendableHeaders(undefined)).toEqual({});
  });
});
