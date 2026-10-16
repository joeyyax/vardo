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
import http from "node:http";
import https from "node:https";
import { Readable, pipeline } from "stream";
import { promisify } from "util";
import { ArchiveMissingError, type BackupStorage, type StoredObject, type UploadStreamOptions } from "./storage-port";
import { withRetry } from "./storage-retry";
import { assertEndpointReachable, backupEndpointLookup } from "./target-guard";
import { BACKUP_SLOT_FORMULA } from "@/lib/resources/defaults";

const pipelineAsync = promisify(pipeline);

const MiB = 1024 * 1024;

/** Smallest part, and the part size when the archive's size is unknown. */
export const PART_SIZE = 16 * MiB;
/** S3's largest part. */
export const MAX_PART_SIZE = 5 * 1024 * MiB;
/** Most parts in flight at once, and the most part buffers an upload holds. */
export const PART_QUEUE = 4;
/** Part buffers one backup slot covers. */
export const SLOT_BUFFER_BYTES = PART_QUEUE * PART_SIZE;
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

/** As many parts as fit in a slot's buffers, at least the two an upload reads before it picks PUT or multipart. */
export function partQueueFor(partSize: number): number {
  return Math.max(2, Math.min(PART_QUEUE, Math.floor(SLOT_BUFFER_BYTES / partSize)));
}

/** Backup slots an upload with `partSize` parts needs: one, plus one per slot's memory its buffers pass the first slot's by. */
export function uploadSlotWeight(partSize: number): number {
  const over = partSize * partQueueFor(partSize) - SLOT_BUFFER_BYTES;
  return 1 + Math.max(0, Math.ceil(over / (BACKUP_SLOT_FORMULA.slotMb * MiB)));
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

  /** `organizationId` is the owning org; null or absent for instance targets. */
  constructor(config: S3StorageConfig, opts: { partSize?: number; organizationId?: string | null } = {}) {
    this.config = config;
    this.partSize = opts.partSize;
    const lookup = backupEndpointLookup(opts.organizationId);
    const agentOptions = { keepAlive: true, maxSockets: 50, lookup } as http.AgentOptions;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true, // Required for Minio, R2, B2
      // A hung part would otherwise hold the upload forever.
      requestHandler: {
        requestTimeout: 120_000,
        connectionTimeout: 30_000,
        httpAgent: new http.Agent(agentOptions),
        httpsAgent: new https.Agent(agentOptions),
      },
    });
    const endpoint = config.endpoint;
    if (endpoint) {
      let vetted: Promise<void> | null = null;
      this.client.middlewareStack.add(
        (next) => async (args) => {
          vetted ??= assertEndpointReachable(opts.organizationId, endpoint).catch((err) => {
            vetted = null;
            throw err;
          });
          await vetted;
          return next(args);
        },
        { step: "initialize", name: "vardoEndpointGuard" },
      );
    }
  }

  private fullKey(key: string): string {
    if (this.config.prefix) {
      const trimmed = this.config.prefix.replace(/^\/+|\/+$/g, "");
      return `${trimmed}/${key}`;
    }
    return key;
  }

  slotWeight(expectedBytes: number | null | undefined): number {
    return uploadSlotWeight(this.partSize ?? choosePartSize(expectedBytes));
  }

  /** One PUT under a part's size, otherwise a multipart upload that aborts on any failure. */
  async uploadStream(key: string, body: Readable, opts: UploadStreamOptions = {}): Promise<{ sizeBytes: number }> {
    const Bucket = this.config.bucket;
    const Key = this.fullKey(key);
    const partSize = this.partSize ?? choosePartSize(opts.expectedBytes);
    const queue = partQueueFor(partSize);
    opts.log?.(`Part size ${partSize / MiB} MiB, ${queue} in flight`);
    const spare: Buffer[] = [];
    const parts = readParts(body, partSize, spare);

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
          if (data.length === partSize) spare.push(data);
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
      // The next part is read only once one is free, so an upload holds `queue` buffers at most.
      for (;;) {
        while (inFlight.size >= queue && !failure) await Promise.race(inFlight);
        if (failure) break;
        const next = await parts.next();
        if (next.done) break;
        send(next.value);
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

/** First allocation for a part. It doubles up to the part size, so a small archive holds about its own size. */
const FIRST_PART_ALLOC = 64 * 1024;

/**
 * Cut a stream into buffers of exactly `size` bytes, plus a shorter last one sized to its data.
 * Full parts reuse buffers pushed onto `spare`, so an upload holds its in-flight parts and no more.
 */
export async function* readParts(body: Readable, size: number, spare: Buffer[] = []): AsyncGenerator<Buffer> {
  let buf: Buffer = Buffer.allocUnsafeSlow(Math.min(size, FIRST_PART_ALLOC));
  let filled = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      if (filled === buf.length) {
        const grown = Buffer.allocUnsafeSlow(Math.min(size, buf.length * 2));
        buf.copy(grown, 0, 0, filled);
        buf = grown;
      }
      const n = Math.min(buf.length - filled, chunk.length - offset);
      chunk.copy(buf, filled, offset, offset + n);
      filled += n;
      offset += n;
      if (filled === size) {
        yield buf;
        buf = spare.pop() ?? Buffer.allocUnsafeSlow(size);
        filled = 0;
      }
    }
  }
  if (filled === 0) return;
  if (filled === buf.length) {
    yield buf;
    return;
  }
  const last = Buffer.allocUnsafeSlow(filled);
  buf.copy(last, 0, 0, filled);
  yield last;
}
