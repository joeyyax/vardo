import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Initialize R2 client
const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

const bucketName = process.env.R2_BUCKET_NAME || "time-files";

/**
 * Generate a presigned URL for uploading a file directly to R2.
 * The client uploads directly to R2, bypassing our server.
 */
export async function getUploadUrl(
  key: string,
  contentType: string,
  expiresIn: number = 3600 // 1 hour default
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Generate a presigned URL for downloading a file from R2.
 * Time-limited access for security.
 */
export async function getDownloadUrl(
  key: string,
  expiresIn: number = 3600, // 1 hour default
  filename?: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    ...(filename && {
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
  });

  return getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Generate a presigned URL for viewing a file in the browser (inline).
 */
export async function getViewUrl(
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  return getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Delete a file from R2.
 */
export async function deleteFile(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  await r2Client.send(command);
}

/**
 * Check if a file exists in R2.
 */
export async function fileExists(key: string): Promise<boolean> {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await r2Client.send(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique R2 key for a file.
 * Format: {orgId}/{projectId}/{fileId}/{filename}
 */
export function generateFileKey(
  orgId: string,
  projectId: string,
  fileId: string,
  filename: string
): string {
  // Sanitize filename to remove special characters
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${orgId}/${projectId}/${fileId}/${safeFilename}`;
}

/**
 * Get file metadata from an R2 key.
 */
export function parseFileKey(key: string): {
  orgId: string;
  projectId: string;
  fileId: string;
  filename: string;
} | null {
  const parts = key.split("/");
  if (parts.length < 4) return null;

  return {
    orgId: parts[0],
    projectId: parts[1],
    fileId: parts[2],
    filename: parts.slice(3).join("/"),
  };
}

/**
 * Check if R2 is configured.
 */
export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}
