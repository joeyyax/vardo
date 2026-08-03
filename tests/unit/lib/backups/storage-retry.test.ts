// A transient resolver failure (getaddrinfo EAI_AGAIN against R2) killed a whole
// nightly backup because nothing retried. These cover the bounded retry that
// wraps every storage adapter, and the classification that keeps a real auth
// failure surfacing immediately.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  withStorageRetry,
  isRetryableStorageError,
  backoffDelayMs,
  StorageRetryError,
  MAX_ATTEMPTS,
  RETRY_BUDGET_MS,
} from "@/lib/backups/storage-retry";
import { createBackupStorage } from "@/lib/backups/storage-factory";
import { S3BackupStorage } from "@/lib/backups/storage-s3";
import { SshBackupStorage } from "@/lib/backups/storage-ssh";
import { LocalBackupStorage } from "@/lib/backups/storage-local";

/** Node's shape for a failed DNS lookup inside a container. */
function dnsError() {
  return Object.assign(
    new Error("getaddrinfo EAI_AGAIN acct.r2.cloudflarestorage.com"),
    { code: "EAI_AGAIN" },
  );
}

function s3Error(name: string, httpStatusCode: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

function stubStorage(overrides: Record<string, unknown> = {}) {
  return {
    upload: vi.fn(async () => ({ sizeBytes: 1 })),
    download: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Drives a retrying call to completion without waiting on real backoff. */
async function runWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await vi.advanceTimersByTimeAsync(MAX_ATTEMPTS * 10_000);
  }

  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isRetryableStorageError", () => {
  it("retries transient network and resolver codes", () => {
    for (const code of ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]) {
      expect(isRetryableStorageError(Object.assign(new Error("boom"), { code }))).toBe(true);
    }
  });

  it("retries 429 and 5xx from the provider", () => {
    expect(isRetryableStorageError(s3Error("SlowDown", 429))).toBe(true);
    expect(isRetryableStorageError(s3Error("InternalError", 500))).toBe(true);
    expect(isRetryableStorageError(s3Error("ServiceUnavailable", 503))).toBe(true);
  });

  it("does not retry auth failures, 403, or a malformed request", () => {
    expect(isRetryableStorageError(s3Error("InvalidAccessKeyId", 403))).toBe(false);
    expect(isRetryableStorageError(s3Error("SignatureDoesNotMatch", 403))).toBe(false);
    expect(isRetryableStorageError(s3Error("AccessDenied", 403))).toBe(false);
    expect(isRetryableStorageError(s3Error("InvalidRequest", 400))).toBe(false);
    expect(isRetryableStorageError(s3Error("NoSuchBucket", 404))).toBe(false);
  });

  it("does not retry a permanent NXDOMAIN", () => {
    expect(isRetryableStorageError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(false);
  });

  it("reads transient reasons out of scp stderr, which only reports exit 255", () => {
    const scpFailure = Object.assign(new Error("Command failed: scp -o ConnectTimeout=30"), {
      code: 255,
      stderr: "ssh: Could not resolve hostname nas: Temporary failure in name resolution",
    });
    expect(isRetryableStorageError(scpFailure)).toBe(true);
  });

  it("does not retry an ssh permission failure", () => {
    const denied = Object.assign(new Error("Command failed: scp"), {
      code: 255,
      stderr: "Permission denied (publickey).",
    });
    expect(isRetryableStorageError(denied)).toBe(false);
  });

  it("unwraps a transient cause", () => {
    expect(isRetryableStorageError(new Error("upload failed", { cause: dnsError() }))).toBe(true);
  });

  it("treats an explicit 4xx as final even when its cause looks transient", () => {
    const authFailure = Object.assign(s3Error("AccessDenied", 403), { cause: dnsError() });
    expect(isRetryableStorageError(authFailure)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and stays capped", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(500);
    expect(backoffDelayMs(2, () => 0)).toBe(1_000);
    expect(backoffDelayMs(3, () => 0)).toBe(2_000);
    expect(backoffDelayMs(20, () => 1)).toBe(8_000);
  });

  it("jitters within the attempt's window so parallel volumes do not sync up", () => {
    const low = backoffDelayMs(3, () => 0);
    const high = backoffDelayMs(3, () => 1);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(0);
  });
});

describe("withStorageRetry", () => {
  it("retries a transient DNS failure and then succeeds", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(dnsError())
      .mockRejectedValueOnce(dnsError())
      .mockResolvedValue({ sizeBytes: 4096 });

    const storage = withStorageRetry(stubStorage({ upload }));
    const result = await runWithoutWaiting(storage.upload("org/app/vol.tar.gz", "/tmp/vol.tar.gz"));

    expect(result).toEqual({ sizeBytes: 4096 });
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("re-enters the adapter each attempt so the file is re-read, never a spent stream", async () => {
    const upload = vi.fn().mockRejectedValueOnce(dnsError()).mockResolvedValue({ sizeBytes: 1 });

    const storage = withStorageRetry(stubStorage({ upload }));
    await runWithoutWaiting(storage.upload("k", "/tmp/archive.tar.gz"));

    expect(upload).toHaveBeenNthCalledWith(1, "k", "/tmp/archive.tar.gz");
    expect(upload).toHaveBeenNthCalledWith(2, "k", "/tmp/archive.tar.gz");
  });

  it("does not retry an auth failure", async () => {
    const upload = vi.fn().mockRejectedValue(s3Error("InvalidAccessKeyId", 403));
    const storage = withStorageRetry(stubStorage({ upload }));

    await expect(runWithoutWaiting(storage.upload("k", "/tmp/f"))).rejects.toThrow(
      "InvalidAccessKeyId",
    );
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("reports an auth failure as itself, not as a retry exhaustion", async () => {
    const storage = withStorageRetry(
      stubStorage({ upload: vi.fn().mockRejectedValue(s3Error("AccessDenied", 403)) }),
    );

    await expect(runWithoutWaiting(storage.upload("k", "/tmp/f"))).rejects.not.toBeInstanceOf(
      StorageRetryError,
    );
  });

  it("bounds retries", async () => {
    const upload = vi.fn().mockRejectedValue(dnsError());
    const storage = withStorageRetry(stubStorage({ upload }));

    await expect(runWithoutWaiting(storage.upload("k", "/tmp/f"))).rejects.toThrow();
    expect(upload).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("stops once the wall-clock budget is spent, however few attempts have run", async () => {
    const upload = vi.fn(async () => {
      vi.setSystemTime(Date.now() + RETRY_BUDGET_MS + 1_000);
      throw dnsError();
    });
    const storage = withStorageRetry(stubStorage({ upload }));

    await expect(runWithoutWaiting(storage.upload("k", "/tmp/f"))).rejects.toThrow();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("reports that it retried, and how often, once retries are exhausted", async () => {
    const storage = withStorageRetry(stubStorage({ upload: vi.fn().mockRejectedValue(dnsError()) }));

    const error = await runWithoutWaiting(storage.upload("k", "/tmp/f")).catch((e) => e);

    expect(error).toBeInstanceOf(StorageRetryError);
    expect(error.attempts).toBe(MAX_ATTEMPTS);
    expect(error.message).toContain("EAI_AGAIN");
    expect(error.message).toContain(`upload failed after ${MAX_ATTEMPTS} attempts`);
    expect(error.cause).toMatchObject({ code: "EAI_AGAIN" });
  });

  it("retries download and delete, not just upload", async () => {
    const download = vi.fn().mockRejectedValueOnce(dnsError()).mockResolvedValue(undefined);
    const del = vi.fn().mockRejectedValueOnce(dnsError()).mockResolvedValue(undefined);

    const storage = withStorageRetry(stubStorage({ download, delete: del }));

    await runWithoutWaiting(storage.download("k", "/tmp/dest"));
    await runWithoutWaiting(storage.delete("k"));

    expect(download).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("names the failing operation in the exhausted error", async () => {
    const storage = withStorageRetry(stubStorage({ delete: vi.fn().mockRejectedValue(dnsError()) }));

    await expect(runWithoutWaiting(storage.delete("k"))).rejects.toThrow(/delete failed after/);
  });

  it("passes presigning straight through — it signs locally and makes no request", async () => {
    const getDownloadUrl = vi.fn(async () => "https://example.test/signed");
    const storage = withStorageRetry(stubStorage({ getDownloadUrl }));

    await expect(storage.getDownloadUrl?.("k", 60)).resolves.toBe("https://example.test/signed");
    expect(getDownloadUrl).toHaveBeenCalledWith("k", 60);
  });

  it("omits getDownloadUrl for adapters that do not support it", () => {
    expect(withStorageRetry(stubStorage()).getDownloadUrl).toBeUndefined();
  });
});

describe("createBackupStorage", () => {
  const targets = [
    { type: "r2" as const, config: { bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" } },
    { type: "ssh" as const, config: { host: "h", username: "u", path: "/backups" } },
    { type: "local" as const, config: { path: "/tmp/vardo-backups" } },
  ];

  it("wraps every adapter, so no transport is left without retry", () => {
    for (const target of targets) {
      const storage = createBackupStorage(target);
      expect(storage).not.toBeInstanceOf(S3BackupStorage);
      expect(storage).not.toBeInstanceOf(SshBackupStorage);
      expect(storage).not.toBeInstanceOf(LocalBackupStorage);
    }
  });

  it("retries through the factory, not just through the decorator directly", async () => {
    const storage = createBackupStorage(targets[2]);
    const spy = vi
      .spyOn(LocalBackupStorage.prototype, "delete")
      .mockRejectedValueOnce(dnsError())
      .mockResolvedValue(undefined);

    await runWithoutWaiting(storage.delete("some-backup.tar.gz"));

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps presigning available on S3-compatible targets only", () => {
    expect(createBackupStorage(targets[0]).getDownloadUrl).toBeTypeOf("function");
    expect(createBackupStorage(targets[1]).getDownloadUrl).toBeUndefined();
    expect(createBackupStorage(targets[2]).getDownloadUrl).toBeUndefined();
  });
});
