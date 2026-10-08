// S3-compatible backup storage adapter (AWS S3, R2, B2, Minio).

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "fs";
import { stat } from "fs/promises";
import { Readable, pipeline } from "stream";
import { promisify } from "util";

const pipelineAsync = promisify(pipeline);
import { ArchiveMissingError, type BackupStorage, type StoredObject } from "./storage-port";

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

  constructor(config: S3StorageConfig) {
    this.config = config;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true, // Required for Minio, R2, B2
    });
  }

  private fullKey(key: string): string {
    if (this.config.prefix) {
      const trimmed = this.config.prefix.replace(/^\/+|\/+$/g, "");
      return `${trimmed}/${key}`;
    }
    return key;
  }

  async upload(key: string, filePath: string): Promise<{ sizeBytes: number }> {
    const fileInfo = await stat(filePath);
    const body = createReadStream(filePath);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentLength: fileInfo.size,
        ContentType: "application/gzip",
      }),
    );

    return { sizeBytes: fileInfo.size };
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
