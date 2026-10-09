// Streamed uploads: S3 multipart (no 5 GiB single-PUT ceiling, no orphaned parts), and local writes that never leave a partial object.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { S3BackupStorage, readParts } from "@/lib/backups/storage-s3";
import { LocalBackupStorage } from "@/lib/backups/storage-local";

const PART = 1024;
const send = vi.spyOn(S3Client.prototype, "send");

function storage() {
  return new S3BackupStorage(
    { bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" },
    { partSize: PART },
  );
}

/** A stream of `n` bytes in odd-sized chunks, so part edges never line up with writes. */
function bytes(n: number): { body: Readable; data: Buffer } {
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = i % 251;
  const chunks: Buffer[] = [];
  for (let i = 0; i < n; i += 333) chunks.push(data.subarray(i, i + 333));
  return { body: Readable.from(chunks), data };
}

/** A source that yields `n` bytes, then fails the way a dying producer does. */
function failingAfter(n: number): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) this.destroy(new Error("tar exited 1"));
      else {
        sent = true;
        this.push(Buffer.alloc(n));
      }
    },
  });
}

function calls<T>(type: new (...args: never[]) => T): T[] {
  return send.mock.calls.map((c) => c[0] as unknown).filter((c): c is T => c instanceof type);
}

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "up-1" };
    if (command instanceof UploadPartCommand) return { ETag: `"etag-${command.input.PartNumber}"` };
    return {};
  });
});

describe("S3 uploadStream", () => {
  it("sends an archive under one part as a single PUT", async () => {
    const { body, data } = bytes(PART - 1);

    const result = await storage().uploadStream("a/b.tar.gz", body);

    expect(result.sizeBytes).toBe(PART - 1);
    const puts = calls(PutObjectCommand);
    expect(puts).toHaveLength(1);
    expect((puts[0].input.Body as Buffer).equals(data)).toBe(true);
    expect(calls(CreateMultipartUploadCommand)).toHaveLength(0);
  });

  it("splits a larger archive into equal parts and completes them in order", async () => {
    const { body, data } = bytes(PART * 5 + 17);

    const result = await storage().uploadStream("a/b.tar.gz", body);

    expect(result.sizeBytes).toBe(data.length);
    const parts = calls(UploadPartCommand);
    expect(parts.map((p) => (p.input.Body as Buffer).length)).toEqual([PART, PART, PART, PART, PART, 17]);
    expect(Buffer.concat(parts.map((p) => p.input.Body as Buffer)).equals(data)).toBe(true);
    const [complete] = calls(CompleteMultipartUploadCommand);
    expect(complete.input.MultipartUpload!.Parts!.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls(AbortMultipartUploadCommand)).toHaveLength(0);
    expect(calls(PutObjectCommand)).toHaveLength(0);
  });

  it("retries a part that fails transiently", async () => {
    vi.useFakeTimers();
    try {
      let failed = false;
      send.mockImplementation(async (command: unknown) => {
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: "up-1" };
        if (command instanceof UploadPartCommand) {
          if (command.input.PartNumber === 2 && !failed) {
            failed = true;
            throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          }
          return { ETag: `"etag-${command.input.PartNumber}"` };
        }
        return {};
      });
      const { body } = bytes(PART * 3);

      const done = storage().uploadStream("k", body);
      await vi.advanceTimersByTimeAsync(20_000);
      await done;

      expect(calls(UploadPartCommand).filter((p) => p.input.PartNumber === 2)).toHaveLength(2);
      expect(calls(CompleteMultipartUploadCommand)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the multipart upload when a part fails for good", async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "up-1" };
      if (command instanceof UploadPartCommand && command.input.PartNumber === 3) {
        throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      }
      if (command instanceof UploadPartCommand) return { ETag: '"e"' };
      return {};
    });
    const { body } = bytes(PART * 8);

    await expect(storage().uploadStream("k", body)).rejects.toThrow("AccessDenied");

    const [abort] = calls(AbortMultipartUploadCommand);
    expect(abort.input.UploadId).toBe("up-1");
    expect(calls(CompleteMultipartUploadCommand)).toHaveLength(0);
  });

  it("aborts when the source stream fails partway", async () => {
    const body = failingAfter(PART * 3);

    await expect(storage().uploadStream("k", body)).rejects.toThrow("tar exited 1");

    expect(calls(AbortMultipartUploadCommand)).toHaveLength(1);
    expect(calls(CompleteMultipartUploadCommand)).toHaveLength(0);
  });
});

describe("readParts", () => {
  it("yields exact-size parts and a short tail", async () => {
    const sizes: number[] = [];
    for await (const part of readParts(bytes(2500).body, 1000)) sizes.push(part.length);
    expect(sizes).toEqual([1000, 1000, 500]);
  });
});

describe("local uploadStream", () => {
  const root = mkdtempSync(join(tmpdir(), "vardo-local-stream-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes the object only once the stream ends", async () => {
    const { body, data } = bytes(5000);

    const result = await new LocalBackupStorage({ path: root }).uploadStream("org/app/a.tar.gz", body);

    expect(result.sizeBytes).toBe(5000);
    expect(readFileSync(join(root, "org/app/a.tar.gz")).equals(data)).toBe(true);
    expect(readdirSync(join(root, "org/app"))).toEqual(["a.tar.gz"]);
  });

  it("leaves nothing behind when the stream fails", async () => {
    const body = failingAfter(100);

    await expect(new LocalBackupStorage({ path: root }).uploadStream("org/app/b.tar.gz", body)).rejects.toThrow();

    expect(readdirSync(join(root, "org/app")).filter((f) => f.startsWith("b.tar.gz"))).toEqual([]);
  });
});
