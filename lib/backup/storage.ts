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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
};

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createStorageClient(config: StorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true, // Required for Minio, R2, B2
  });
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Build the full S3 object key, prepending the optional prefix. */
function fullKey(config: StorageConfig, key: string): string {
  if (config.prefix) {
    const trimmed = config.prefix.replace(/^\/+|\/+$/g, "");
    return `${trimmed}/${key}`;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Upload a local file to S3-compatible storage.
 * Returns the size in bytes.
 */
export async function uploadBackup(
  client: S3Client,
  config: StorageConfig,
  key: string,
  filePath: string,
): Promise<{ sizeBytes: number }> {
  const fileInfo = await stat(filePath);
  const body = createReadStream(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: fullKey(config, key),
      Body: body,
      ContentLength: fileInfo.size,
      ContentType: "application/gzip",
    }),
  );

  return { sizeBytes: fileInfo.size };
}

/**
 * Download a backup from S3-compatible storage to a local file.
 */
export async function downloadBackup(
  client: S3Client,
  config: StorageConfig,
  key: string,
  destPath: string,
): Promise<void> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: fullKey(config, key),
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

/**
 * Delete a backup object from S3-compatible storage.
 */
export async function deleteBackup(
  client: S3Client,
  config: StorageConfig,
  key: string,
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: fullKey(config, key),
    }),
  );
}

/**
 * Generate a pre-signed download URL for a backup.
 * Defaults to 1 hour expiry.
 */
export async function getDownloadUrl(
  client: S3Client,
  config: StorageConfig,
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: fullKey(config, key),
  });

  return getSignedUrl(client, command, { expiresIn });
}
