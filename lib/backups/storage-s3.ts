// S3-compatible backup storage adapter (AWS S3, R2, B2, Minio).

import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "fs";
import { Readable, pipeline } from "stream";
import { promisify } from "util";
import { ArchiveMissingError, type BackupStorage, type StoredObject, type UploadStreamOptions } from "./storage-port";
import { withRetry } from "./storage-retry";

const pipelineAsync = promisify(pipeline);

const MiB = 1024 * 1024;

/** Smallest part, and the part size when the archive's size is unknown. */
export const PART_SIZE = 16 * MiB;
/** S3's largest part. */
export const MAX_PART_SIZE = 5 * 1024 * MiB;
/** Parts in flight at once. Memory is about (queue + 1) × part size. */
export const PART_QUEUE = 4;
/** Queue for parts over LARGE_PART_SIZE, so a huge volume doesn't hold gigabytes. */
export const LARGE_PART_QUEUE = 2;
export const LARGE_PART_SIZE = 64 * MiB;
const MAX_PARTS = 10_000;
/** Parts the expected size is spread over, leaving headroom under MAX_PARTS. */
const TARGET_PARTS = 9_000;

/**
 * One part size for the whole upload: R2 rejects unequal non-trailing parts.
 * `expectedBytes` is an upper bound, such as the uncompressed volume size.
 */
export function choosePartSize(expectedBytes: number | null | undefined): number {
  if (!expectedBytes || !Number.isFinite(expectedBytes) || expectedBytes <= 0) return PART_SIZE;
  const wholeMiB = Math.ceil(Math.ceil((expectedBytes * 1.5) / TARGET_PARTS) / MiB) * MiB;
  return Math.min(MAX_PART_SIZE, Math.max(PART_SIZE, wholeMiB));
}

export function partQueueFor(partSize: number): number {
  return partSize > LARGE_PART_SIZE ? LARGE_PART_QUEUE : PART_QUEUE;
}

export type S3StorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
};

/** GetObject reports NoSuchKey; HeadObject has no body, so only NotFound. */
function isMissing(err: unknown): boolean {
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export class S3BackupStorage implements BackupStorage {
  private client: S3Client;
  private config: S3StorageConfig;
  /** Fixed part size, overriding choosePartSize. */
  private partSize: number | undefined;

  constructor(config: S3StorageConfig, opts: { partSize?: number } = {}) {
    this.config = config;
    this.partSize = opts.partSize;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true, // Required for Minio, R2, B2
      // A hung part would otherwise hold the upload forever.
      requestHandler: { requestTimeout: 120_000, connectionTimeout: 30_000 },
    });
  }

  private fullKey(key: string): string {
    if (this.config.prefix) {
      const trimmed = this.config.prefix.replace(/^\/+|\/+$/g, "");
      return `${trimmed}/${key}`;
    }
    return key;
  }

  /** One PUT under a part's size, otherwise a multipart upload that aborts on any failure. */
  async uploadStream(key: string, body: Readable, opts: UploadStreamOptions = {}): Promise<{ sizeBytes: number }> {
    const Bucket = this.config.bucket;
    const Key = this.fullKey(key);
    const partSize = this.partSize ?? choosePartSize(opts.expectedBytes);
    const queue = partQueueFor(partSize);
    opts.log?.(`Part size ${partSize / MiB} MiB, ${queue} in flight`);
    const parts = readParts(body, partSize);

    const first = await parts.next();
    const firstPart = first.done ? Buffer.alloc(0) : first.value;
    const second = first.done ? first : await parts.next();
    if (second.done) {
      await withRetry("upload", key, () =>
        this.client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body: firstPart,
            ContentLength: firstPart.length,
            ContentType: "application/gzip",
          }),
        ),
      );
      return { sizeBytes: firstPart.length };
    }

    const { UploadId } = await withRetry("upload", key, () =>
      this.client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType: "application/gzip" })),
    );
    if (!UploadId) throw new Error("Storage returned no multipart upload ID");

    const done: { ETag: string; PartNumber: number }[] = [];
    const inFlight = new Set<Promise<void>>();
    let failure: unknown = null;
    let sizeBytes = 0;
    let partNumber = 0;

    const send = (data: Buffer) => {
      const PartNumber = ++partNumber;
      if (PartNumber > MAX_PARTS) throw new Error(`Archive exceeds ${MAX_PARTS} parts of ${partSize / MiB} MiB`);
      sizeBytes += data.length;
      const task = withRetry(`upload part ${PartNumber}`, key, () =>
        this.client.send(
          new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body: data, ContentLength: data.length }),
        ),
      )
        .then(({ ETag }) => {
          if (!ETag) throw new Error(`Storage returned no ETag for part ${PartNumber}`);
          done.push({ ETag, PartNumber });
        })
        .catch((err) => {
          failure ??= err;
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    };

    try {
      send(firstPart);
      send(second.value);
      for await (const part of parts) {
        while (inFlight.size >= queue && !failure) await Promise.race(inFlight);
        if (failure) break;
        send(part);
      }
      await Promise.all(inFlight);
      if (failure) throw failure;

      done.sort((a, b) => a.PartNumber - b.PartNumber);
      await withRetry("upload complete", key, () =>
        this.client.send(
          new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: done } }),
        ),
      );
      return { sizeBytes };
    } catch (err) {
      body.destroy();
      await Promise.allSettled(inFlight);
      // Abandoned parts are billed until aborted.
      await withRetry("upload abort", key, () =>
        this.client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })),
      ).catch(() => {});
      throw err;
    }
  }

  async download(key: string, destPath: string): Promise<void> {
    const response = await this.client
      .send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: this.fullKey(key),
        }),
      )
      .catch((err) => {
        throw isMissing(err) ? new ArchiveMissingError() : err;
      });

    if (!response.Body) {
      throw new Error(`Empty response body for key: ${key}`);
    }

    // Stream to disk; archives don't fit in memory.
    const stream = response.Body as Readable;
    await pipelineAsync(stream, createWriteStream(destPath));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.fullKey(key),
      }),
    );
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const full = this.fullKey(prefix);
    const strip = full.length - prefix.length;
    const found: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: full, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        found.push({
          key: obj.Key.slice(strip),
          sizeBytes: obj.Size ?? 0,
          modifiedAt: obj.LastModified ?? new Date(0),
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return found;
  }

  /** Checks the object exists before presigning. */
  async getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    await this.client
      .send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.fullKey(key) }))
      .catch((err) => {
        throw isMissing(err) ? new ArchiveMissingError() : err;
      });

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: this.fullKey(key),
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }
}

/** Cut a stream into buffers of exactly `size` bytes, plus a shorter last one. */
export async function* readParts(body: Readable, size: number): AsyncGenerator<Buffer> {
  let buf = Buffer.allocUnsafe(size);
  let filled = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(size - filled, chunk.length - offset);
      chunk.copy(buf, filled, offset, offset + n);
      filled += n;
      offset += n;
      if (filled === size) {
        yield buf;
        buf = Buffer.allocUnsafe(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buf.subarray(0, filled);
}
