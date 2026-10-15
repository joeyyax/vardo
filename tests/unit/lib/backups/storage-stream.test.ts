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
import {
  LARGE_PART_QUEUE,
  LARGE_PART_SIZE,
  MAX_PART_SIZE,
  PART_QUEUE,
  PART_SIZE,
  S3BackupStorage,
  choosePartSize,
  partQueueFor,
  readParts,
} from "@/lib/backups/storage-s3";
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

/** Each part's bytes as sent. The uploader reuses a part's buffer once the part is stored. */
const sentParts = new Map<number, Buffer>();

function sentBytes(): Buffer {
  return Buffer.concat([...sentParts.keys()].sort((a, b) => a - b).map((n) => sentParts.get(n)!));
}

/** Full-size buffers an upload of `parts` parts allocates when each part takes a few milliseconds to store. Buffers are reused, so this is its peak. */
async function peakPartBuffers(partSize: number, parts: number): Promise<number> {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "up-1" };
    if (command instanceof UploadPartCommand) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ETag: `"etag-${command.input.PartNumber}"` };
    }
    return {};
  });
  const chunk = Buffer.alloc(1024 * 1024);
  const total = partSize * parts + 1;
  const body = Readable.from(
    (function* () {
      for (let left = total; left > 0; left -= chunk.length) yield left < chunk.length ? chunk.subarray(0, left) : chunk;
    })(),
  );
  const s3 = new S3BackupStorage({ bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" }, { partSize });

  expect((await s3.uploadStream("k", body)).sizeBytes).toBe(total);

  const full = calls(UploadPartCommand).map((p) => p.input.Body as Buffer).filter((b) => b.length === partSize);
  expect(full).toHaveLength(parts);
  return new Set(full.map((b) => b.buffer)).size;
}

beforeEach(() => {
  send.mockReset();
  sentParts.clear();
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "up-1" };
    if (command instanceof UploadPartCommand) {
      sentParts.set(command.input.PartNumber!, Buffer.from(command.input.Body as Buffer));
      return { ETag: `"etag-${command.input.PartNumber}"` };
    }
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
    expect(sentBytes().equals(data)).toBe(true);
    const [complete] = calls(CompleteMultipartUploadCommand);
    expect(complete.input.MultipartUpload!.Parts!.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls(AbortMultipartUploadCommand)).toHaveLength(0);
    expect(calls(PutObjectCommand)).toHaveLength(0);
  });

  it("holds a small archive in a buffer its own size, not a whole part", async () => {
    const s3 = new S3BackupStorage({ bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" });
    const { body, data } = bytes(100_003);

    await s3.uploadStream("k", body);

    const sent = calls(PutObjectCommand)[0].input.Body as Buffer;
    expect(sent.equals(data)).toBe(true);
    expect(sent.buffer.byteLength).toBe(100_003);
  });

  it("reuses a part's buffer once the part is stored", async () => {
    // Past Buffer's pool, so every allocation gets its own ArrayBuffer.
    const partSize = 64 * 1024;
    const s3 = new S3BackupStorage({ bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" }, { partSize });
    const { body, data } = bytes(partSize * 20 + 5);

    await s3.uploadStream("k", body);

    const buffers = new Set(calls(UploadPartCommand).map((p) => (p.input.Body as Buffer).buffer));
    expect(buffers.size).toBeLessThanOrEqual(PART_QUEUE + 2);
    expect(sentBytes().equals(data)).toBe(true);
  });

  it("holds at most PART_QUEUE part buffers while every slot is busy", async () => {
    expect(await peakPartBuffers(64 * 1024, 12)).toBe(PART_QUEUE);
  });

  it("holds at most LARGE_PART_QUEUE buffers for parts over LARGE_PART_SIZE", async () => {
    expect(await peakPartBuffers(LARGE_PART_SIZE + 1024 * 1024, 4)).toBe(LARGE_PART_QUEUE);
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

  it("sizes a short archive's buffer to its data, not the part size", async () => {
    const parts: Buffer[] = [];
    for await (const part of readParts(bytes(100_003).body, PART_SIZE)) parts.push(part);
    expect(parts.map((p) => p.length)).toEqual([100_003]);
    expect(parts[0].buffer.byteLength).toBe(100_003);
  });

  it("sizes the short tail of a long archive to its data", async () => {
    const parts: Buffer[] = [];
    for await (const part of readParts(bytes(2500).body, 1000)) parts.push(part);
    expect(parts[2].buffer.byteLength).toBe(500);
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

describe("part size", () => {
  const MiB = 1024 * 1024;
  const GB = 1e9;

  it("falls back to 16 MiB when the size is unknown", () => {
    expect(choosePartSize(null)).toBe(PART_SIZE);
    expect(choosePartSize(undefined)).toBe(PART_SIZE);
    expect(choosePartSize(0)).toBe(PART_SIZE);
    expect(choosePartSize(Number.NaN)).toBe(PART_SIZE);
  });

  it("never goes under 16 MiB", () => {
    expect(choosePartSize(4 * GB)).toBe(16 * MiB);
  });

  it("spreads 1.5 × the expected size over 9,000 parts, in whole MiB", () => {
    // 1.5e12 / 9000 = 166,666,667 bytes = 158.9 MiB.
    expect(choosePartSize(1000 * GB)).toBe(159 * MiB);
    // 1.5 × 200 GB / 9000 = 31.8 MiB.
    expect(choosePartSize(200 * GB)).toBe(32 * MiB);
  });

  it("keeps any archive up to 1.5 × the expected size under 10,000 parts", () => {
    for (const expected of [97 * GB, 160 * GB, 1000 * GB, 7_000 * GB]) {
      expect(Math.ceil((expected * 1.5) / choosePartSize(expected))).toBeLessThanOrEqual(10_000);
    }
  });

  it("caps at S3's 5 GiB part limit", () => {
    expect(choosePartSize(100_000 * GB)).toBe(MAX_PART_SIZE);
  });

  it("halves the queue once parts pass 64 MiB", () => {
    expect(partQueueFor(64 * MiB)).toBe(PART_QUEUE);
    expect(partQueueFor(65 * MiB)).toBe(LARGE_PART_QUEUE);
  });

  it("logs the part size it chose from the expected size", async () => {
    const log = vi.fn();
    const s3 = new S3BackupStorage({ bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" });

    await s3.uploadStream("k", bytes(10).body, { expectedBytes: 1000 * GB, log });

    expect(log).toHaveBeenCalledWith("Part size 159 MiB, 2 in flight");
  });
});
