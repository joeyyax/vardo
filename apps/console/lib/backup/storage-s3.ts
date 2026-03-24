// ---------------------------------------------------------------------------
// S3 Backup Storage Adapter
//
// Wraps S3-compatible storage (AWS S3, R2, B2, Minio) as a BackupStorage
// implementation. Extracted from the original storage.ts module.
// ---------------------------------------------------------------------------

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "fs";
import { writeFile, stat } from "fs/promises";
import { Readable } from "stream";
import type { BackupStorage } from "./storage-port";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type S3StorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

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

  /** Build the full S3 object key, prepending the optional prefix. */
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
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.fullKey(key),
      }),
    );

    if (!response.Body) {
      throw new Error(`Empty response body for key: ${key}`);
    }

    // The SDK returns a web ReadableStream; convert to Buffer
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await writeFile(destPath, Buffer.concat(chunks));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.fullKey(key),
      }),
    );
  }

  async getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: this.fullKey(key),
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }
}
