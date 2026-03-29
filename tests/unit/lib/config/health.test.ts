import { describe, it, expect } from "vitest";
import { sanitizeError } from "@/lib/config/health";

// ---------------------------------------------------------------------------
// sanitizeError — strips sensitive internals from library error messages
// ---------------------------------------------------------------------------
// ioredis connection failures can expose internal host:port and connection URLs.
// pg/Drizzle errors can expose role, database, and user names.
// This verifies redaction is both correct (catches real patterns) and
// conservative (doesn't corrupt unrelated messages).

describe("sanitizeError", () => {
  // --- Redis/connection URL patterns ---

  it("strips a redis:// URL", () => {
    expect(sanitizeError("connect ECONNREFUSED redis://localhost:6379")).toBe(
      "connect ECONNREFUSED [url]"
    );
  });

  it("strips a redis URL with credentials", () => {
    expect(sanitizeError("connect ECONNREFUSED redis://:password@10.0.0.1:6379/0")).toBe(
      "connect ECONNREFUSED [url]"
    );
  });

  it("strips a postgres:// URL", () => {
    expect(sanitizeError("connect ECONNREFUSED postgres://localhost:5432/vardo")).toBe(
      "connect ECONNREFUSED [url]"
    );
  });

  it("strips a postgresql:// URL", () => {
    expect(sanitizeError("connection failed: postgresql://user:pass@db.internal:5432/prod")).toBe(
      "connection failed: [url]"
    );
  });

  // --- IPv4 host patterns ---

  it("strips an IPv4 address with port", () => {
    expect(sanitizeError("connect ECONNREFUSED 127.0.0.1:6379")).toBe(
      "connect ECONNREFUSED [host]"
    );
  });

  it("strips a private IPv4 address with port", () => {
    expect(sanitizeError("connect ECONNREFUSED 10.0.0.1:5432")).toBe(
      "connect ECONNREFUSED [host]"
    );
  });

  it("strips an IPv4 address without port", () => {
    expect(sanitizeError("host unreachable: 192.168.1.100")).toBe(
      "host unreachable: [host]"
    );
  });

  // --- localhost patterns ---

  it("strips localhost with port", () => {
    expect(sanitizeError("ECONNREFUSED localhost:7200")).toBe(
      "ECONNREFUSED [host]"
    );
  });

  it("strips bare localhost", () => {
    expect(sanitizeError("cannot connect to localhost")).toBe(
      "cannot connect to [host]"
    );
  });

  // --- pg role/database/user name patterns ---

  it("strips pg user name from authentication errors", () => {
    expect(sanitizeError('password authentication failed for user "postgres"')).toBe(
      'password authentication failed for user [name]'
    );
  });

  it("strips pg role name", () => {
    expect(sanitizeError('permission denied for role "vardo_admin"')).toBe(
      'permission denied for role [name]'
    );
  });

  it("strips pg database name", () => {
    expect(sanitizeError('database "vardo_prod" does not exist')).toBe(
      'database [name] does not exist'
    );
  });

  // --- Length cap ---

  it("caps messages at 120 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizeError(long)).toHaveLength(120);
  });

  // --- Safe passthrough cases ---

  it("passes through a short safe message unchanged", () => {
    expect(sanitizeError("unreachable")).toBe("unreachable");
  });

  it("passes through a numeric status code unchanged", () => {
    expect(sanitizeError("503")).toBe("503");
  });

  it("passes through an empty string unchanged", () => {
    expect(sanitizeError("")).toBe("");
  });
});
