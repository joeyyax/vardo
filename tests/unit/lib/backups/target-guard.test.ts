// Org backup targets can't point the console at internal hosts or arbitrary host paths.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({ trusted: false, allowlist: [] as string[] }));

vi.mock("@/lib/db", () => ({
  db: { query: { organizations: { findFirst: async () => ({ trusted: state.trusted }) } } },
}));
vi.mock("@/lib/security/outbound-policy", () => ({
  getOutboundPolicy: async () => ({ allowlist: state.allowlist }),
}));

const { assertTargetAllowed, assertEndpointReachable, TargetRefusedError } = await import("@/lib/backups/target-guard");
const { S3BackupStorage } = await import("@/lib/backups/storage-s3");

const ORG = { organizationId: "org-1", trusted: false, instanceAdmin: false };
const s3 = (endpoint: string) => ({ bucket: "b", region: "auto", endpoint, accessKeyId: "a", secretAccessKey: "s" });

beforeEach(() => {
  state.trusted = false;
  state.allowlist = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("S3 endpoint", () => {
  it.each(["http://169.254.169.254", "http://127.0.0.1:9000", "http://10.0.0.5", "http://[::1]:9000", "http://[::ffff:127.0.0.1]"])(
    "refuses %s for an untrusted org",
    async (endpoint) => {
      await expect(assertTargetAllowed("s3", s3(endpoint), ORG)).rejects.toBeInstanceOf(TargetRefusedError);
    },
  );

  it("refuses a non-http scheme", async () => {
    await expect(assertTargetAllowed("r2", s3("file:///etc/passwd"), ORG)).rejects.toBeInstanceOf(TargetRefusedError);
  });

  it("allows a public address", async () => {
    await expect(assertTargetAllowed("s3", s3("https://93.184.215.14"), ORG)).resolves.toBeUndefined();
  });

  it("allows a private host on the instance allowlist", async () => {
    state.allowlist = ["10.0.0.5"];
    await expect(assertTargetAllowed("s3", s3("http://10.0.0.5:9000"), ORG)).resolves.toBeUndefined();
  });

  it("lets a trusted org reach a private host but never link-local", async () => {
    const ctx = { ...ORG, trusted: true };
    state.trusted = true;
    await expect(assertTargetAllowed("s3", s3("http://10.0.0.5:9000"), ctx)).resolves.toBeUndefined();
    await expect(assertTargetAllowed("s3", s3("http://169.254.169.254"), ctx)).rejects.toBeInstanceOf(TargetRefusedError);
  });

  it("refuses link-local at request time even for instance targets", async () => {
    await expect(assertEndpointReachable(null, "http://169.254.169.254")).rejects.toThrow(/link-local/);
    await expect(assertEndpointReachable(null, "http://10.0.0.5:9000")).resolves.toBeUndefined();
  });

  it("stops the S3 client before it sends to a refused endpoint", async () => {
    const storage = new S3BackupStorage(s3("http://127.0.0.1:1"), { organizationId: "org-1" });
    await expect(storage.list("k")).rejects.toThrow(/loopback/);
  });
});

describe("SSH host", () => {
  it("refuses a loopback host for an untrusted org", async () => {
    const config = { host: "127.0.0.1", username: "u", path: "/x" };
    await expect(assertTargetAllowed("ssh", config, ORG)).rejects.toBeInstanceOf(TargetRefusedError);
  });
});

describe("local path", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vardo-local-"));
    mkdirSync(join(root, "org-1"));
    vi.stubEnv("VARDO_LOCAL_BACKUP_ROOTS", root);
  });

  it("refuses an untrusted org even inside the root", async () => {
    await expect(assertTargetAllowed("local", { path: join(root, "org-1") }, ORG)).rejects.toThrow(/trusted/);
  });

  it("allows an instance admin inside the root", async () => {
    const ctx = { ...ORG, instanceAdmin: true };
    await expect(assertTargetAllowed("local", { path: join(root, "org-1") }, ctx)).resolves.toBeUndefined();
  });

  it.each(["/etc", "relative/dir", "ROOT/org-1/../../etc", "ROOT-other"])("refuses %s", async (p) => {
    const ctx = { ...ORG, trusted: true };
    await expect(assertTargetAllowed("local", { path: p.replace("ROOT", root) }, ctx)).rejects.toBeInstanceOf(TargetRefusedError);
  });

  it("refuses a symlink that leaves the root", async () => {
    symlinkSync("/etc", join(root, "escape"));
    const ctx = { ...ORG, trusted: true };
    await expect(assertTargetAllowed("local", { path: join(root, "escape") }, ctx)).rejects.toBeInstanceOf(TargetRefusedError);
  });
});
