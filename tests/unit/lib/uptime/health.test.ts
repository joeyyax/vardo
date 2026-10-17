import { describe, expect, it } from "vitest";
import { HASH_BODY_BYTES, hashBody, judgeHomepage, parseHealthcheckPath, qualifiesAsHealth, type Sample } from "@/lib/uptime/core";

describe("parseHealthcheckPath", () => {
  it.each([
    [["CMD", "curl", "-f", "http://localhost:3000/health"], "/health"],
    [["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/api/health || exit 1"], "/api/health"],
    [["CMD-SHELL", "wget -q --spider http://localhost/up"], "/up"],
    [["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://0.0.0.0:80/healthz"], "/healthz"],
    ["CMD curl -f http://localhost:9000/ping", "/ping"],
    [["CMD", "curl", "-f", "localhost:3000/status"], "/status"],
    [["CMD", "curl", "-H", "Accept: json", "-f", "http://localhost/ready"], "/ready"],
    [["CMD", "curl", "-f", "http://[::1]:3000/livez"], "/livez"],
    [["CMD-SHELL", "curl -fsS http://localhost:3000/healthz || wget -q --spider http://localhost:3000/healthz || exit 1"], "/healthz"],
  ])("reads %j", (test, path) => expect(parseHealthcheckPath(test)).toBe(path));

  it.each([
    [undefined],
    [["NONE"]],
    [["CMD", "pg_isready", "-U", "postgres"]],
    [["CMD-SHELL", "curl -f http://example.com/health"]],
    [["CMD-SHELL", "curl -f http://localhost/health?full=1"]],
    [["CMD-SHELL", "curl -f http://localhost/$PATH_VAR"]],
    [["CMD-SHELL", "curl -f http://localhost/health && touch /tmp/ok"]],
    [["CMD-SHELL", "curl -f http://localhost/a http://localhost/b"]],
    [["CMD-SHELL", "curl -f http://localhost"]],
    [["CMD", "/bin/check"]],
    [["CMD-SHELL", "curl -f http://localhost/a || curl -f http://localhost/b"]],
  ])("gives up on %j", (test) => expect(parseHealthcheckPath(test as string[] | undefined)).toBeNull());
});

const sample = (over: Partial<Sample> = {}): Sample => ({ status: 200, contentType: "application/json", bytes: 15, hash: hashBody('{"status":"ok"}'), ...over });
const home = sample({ contentType: "text/html; charset=utf-8", bytes: 40_000, hash: hashBody("<html>home</html>") });

describe("qualifiesAsHealth", () => {
  it("accepts a 2xx JSON or plain text answer that differs from the homepage", () => {
    expect(qualifiesAsHealth(sample(), home)).toBe(true);
    expect(qualifiesAsHealth(sample({ contentType: "text/plain", bytes: 5_000 }), home)).toBe(true);
    expect(qualifiesAsHealth(sample({ contentType: "application/problem+json", bytes: 5_000 }), home)).toBe(true);
  });

  it("accepts a small body of any type, and refuses a large HTML one", () => {
    expect(qualifiesAsHealth(sample({ contentType: "text/html", bytes: 2048 }), home)).toBe(true);
    expect(qualifiesAsHealth(sample({ contentType: "text/html", bytes: 2049 }), home)).toBe(false);
  });

  it("refuses anything but 2xx", () => {
    for (const status of [199, 301, 401, 404, 503]) expect(qualifiesAsHealth(sample({ status }), home)).toBe(false);
  });

  it("refuses a catch-all that serves the homepage on every path", () => {
    expect(qualifiesAsHealth({ ...home, bytes: 100 }, home)).toBe(false);
    expect(qualifiesAsHealth({ ...home }, home)).toBe(false);
  });

  it("does not need a homepage to compare with", () => {
    expect(qualifiesAsHealth(sample(), null)).toBe(true);
  });

  it("hashes bytes and text alike", () => {
    expect(hashBody("a")).toBe(hashBody(Buffer.from("a")));
    expect(HASH_BODY_BYTES).toBeGreaterThan(2048);
  });
});

describe("judgeHomepage", () => {
  it("passes a 2xx", () => expect(judgeHomepage(200, "/", "/")).toEqual({ kind: "ok" }));
  it("asks about a 4xx", () => {
    expect(judgeHomepage(401, "/", "/")).toEqual({ kind: "review", status: 401, reason: "status" });
    expect(judgeHomepage(404, "/", "/")).toEqual({ kind: "review", status: 404, reason: "status" });
  });
  it("asks about a redirect that lands on a login page", () => {
    expect(judgeHomepage(200, "/login", "/")).toEqual({ kind: "review", status: 200, reason: "login" });
    expect(judgeHomepage(200, "/signin", "/")).toEqual({ kind: "review", status: 200, reason: "login" });
  });
  it("lets an ordinary redirect pass", () => expect(judgeHomepage(200, "/en/", "/")).toEqual({ kind: "ok" }));
  it("learns nothing from a 5xx or no answer", () => {
    expect(judgeHomepage(503, "/", "/")).toEqual({ kind: "unreachable" });
    expect(judgeHomepage(null, "/", "/")).toEqual({ kind: "unreachable" });
  });
});
