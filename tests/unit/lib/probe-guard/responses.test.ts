import { describe, expect, it } from "vitest";
import { RESPONSE_HEADERS, allLines, responseBody, type ResponseKind } from "@/lib/probe-guard/responses";

const KINDS: ResponseKind[] = [
  "secrets", "vcs", "wordpress", "db-admin", "cgi", "framework", "server-info", "backup", "traversal", "router",
  "trap", "canary", "banned",
];

// Anything that would name the app, its stack, versions or Vardo itself.
const REVEALING = /vardo|traefik|next\.?js|node|nginx|apache|docker|postgres|redis|ubuntu|debian|version|v\d+\.\d+|\d+\.\d+\.\d+/i;
const PROFANE = /\b(?:damn|hell|crap|shit|fuck|ass|idiot|stupid|loser|hacker|script kiddie|skid)\b/i;

describe("responseBody", () => {
  it("has lines for every kind", () => {
    for (const kind of KINDS) expect(responseBody(kind, 403, true, () => 0).trim()).not.toBe("");
  });

  it("never names the app, its stack or Vardo", () => {
    for (const line of allLines()) expect(line, line).not.toMatch(REVEALING);
  });

  it("stays polite and short", () => {
    for (const line of allLines()) {
      expect(line, line).not.toMatch(PROFANE);
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  it("falls back to plain text with humor off", () => {
    expect(responseBody("secrets", 404, false)).toBe("Not Found\n");
    expect(responseBody("wordpress", 403, false)).toBe("Forbidden\n");
    expect(responseBody("banned", 403, false)).toBe("Forbidden\n");
  });

  it("picks within range for any random value", () => {
    expect(responseBody("vcs", 404, true, () => 0.999999)).toMatch(/\S/);
    expect(responseBody("vcs", 404, true, () => 1)).toMatch(/\S/);
  });

  it("is never cached", () => {
    expect(RESPONSE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(RESPONSE_HEADERS["Content-Type"]).toMatch(/^text\/plain/);
  });
});
