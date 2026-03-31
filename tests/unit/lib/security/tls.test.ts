import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock validate-domain before importing the module under test.
vi.mock("@/lib/security/validate-domain", () => ({
  assertPublicDomain: vi.fn().mockResolvedValue(undefined),
}));

const { mockConnect } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
}));

vi.mock("tls", () => ({
  connect: mockConnect,
}));

import { checkTls } from "@/lib/security/tls";

beforeEach(() => {
  vi.clearAllMocks();
});

type SocketOpts = {
  authorized: boolean;
  authorizationError?: string | null;
  cert: { valid_to: string } | null;
  shouldError?: boolean;
};

/**
 * Configures mockConnect to return a fake TLS socket.
 *
 * The connect callback fires asynchronously (via setImmediate) so that
 * socket.on("error", ...) is wired up before any events are emitted —
 * matching real TLS connection lifecycle.
 */
function setupTlsConnect(opts: SocketOpts): void {
  const errorHandlers: Array<(err: Error) => void> = [];
  let connectCb: (() => void) | null = null;

  const socket = {
    authorized: opts.authorized,
    authorizationError: opts.authorizationError ?? null,
    getPeerCertificate: vi.fn().mockReturnValue(opts.cert),
    destroy: vi.fn(),
    on: vi.fn().mockImplementation((event: string, handler: (err: Error) => void) => {
      if (event === "error") errorHandlers.push(handler);
      return socket;
    }),
  };

  mockConnect.mockImplementation((_opts: unknown, cb: () => void) => {
    connectCb = cb;
    if (opts.shouldError) {
      setImmediate(() => errorHandlers.forEach((h) => h(new Error("ECONNREFUSED"))));
    } else {
      setImmediate(() => {
        if (connectCb) connectCb();
      });
    }
    return socket;
  });
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000 + 60_000).toUTCString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toUTCString();
}

describe("checkTls", () => {
  describe("valid certificate", () => {
    it("returns no findings for a trusted cert expiring in 30 days", async () => {
      setupTlsConnect({ authorized: true, cert: { valid_to: daysFromNow(30) } });
      const findings = await checkTls("example.com");
      expect(findings).toEqual([]);
    });
  });

  describe("expired certificate", () => {
    it("returns a critical finding when the certificate has expired", async () => {
      setupTlsConnect({ authorized: true, cert: { valid_to: daysAgo(5) } });
      const findings = await checkTls("example.com");
      const critical = findings.find(
        (f) => f.severity === "critical" && f.title === "TLS certificate has expired",
      );
      expect(critical).toBeDefined();
      expect(critical?.type).toBe("tls");
    });
  });

  describe("expiring soon", () => {
    it("returns a warning with day count when cert expires within 14 days", async () => {
      setupTlsConnect({ authorized: true, cert: { valid_to: daysFromNow(7) } });
      const findings = await checkTls("example.com");
      const warning = findings.find((f) => f.severity === "warning");
      expect(warning).toBeDefined();
      expect(warning?.title).toMatch(/7 day/);
      expect(warning?.type).toBe("tls");
    });
  });

  describe("untrusted certificate", () => {
    it("returns a critical finding when the certificate is not trusted", async () => {
      setupTlsConnect({
        authorized: false,
        authorizationError: "SELF_SIGNED_CERT_IN_CHAIN",
        cert: { valid_to: daysFromNow(90) },
      });
      const findings = await checkTls("example.com");
      const critical = findings.find(
        (f) => f.severity === "critical" && f.title === "TLS certificate is invalid",
      );
      expect(critical).toBeDefined();
      expect(critical?.description).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    });
  });

  describe("connection error", () => {
    it("returns empty findings when the TLS connection fails", async () => {
      setupTlsConnect({ authorized: false, cert: null, shouldError: true });
      const findings = await checkTls("example.com");
      expect(findings).toEqual([]);
    });
  });
});
