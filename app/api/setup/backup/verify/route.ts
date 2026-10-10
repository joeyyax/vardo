import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { requireAdminAuth } from "@/lib/auth/admin";
import { adminVerifyRefusal } from "@/lib/auth/admin-error";
import { getBackupStorageConfig } from "@/lib/system-settings";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { withRateLimit } from "@/lib/api/with-rate-limit";

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  try {
    await requireAdminAuth();
  } catch (error) {
    return adminVerifyRefusal(error);
  }

  const config = await getBackupStorageConfig();
  if (!config) {
    return NextResponse.json({
      ok: false,
      message: "Backup storage isn't configured — save your settings first",
    });
  }

  if (!config.bucket) {
    return NextResponse.json({ ok: false, message: "Bucket name is missing" });
  }

  if (!config.accessKey || !config.secretKey) {
    return NextResponse.json({ ok: false, message: "Access key or secret key is missing" });
  }

  try {
    const s3 = new S3Client({
      region: config.region || "us-east-1",
      ...(config.endpoint && { endpoint: config.endpoint }),
      forcePathStyle: config.type !== "s3", // R2 and B2 need path-style
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      requestHandler: {
        requestTimeout: 10_000,
      } as never,
    });

    await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
    s3.destroy();

    const typeLabel = config.type === "r2" ? "Cloudflare R2" : config.type === "b2" ? "Backblaze B2" : "S3";
    return NextResponse.json({
      ok: true,
      message: `Connected to ${typeLabel} bucket "${config.bucket}"`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";

    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("AccessDenied")) {
      return NextResponse.json({
        ok: false,
        message: "Access denied — check your credentials and bucket permissions",
      });
    }
    if (msg.includes("404") || msg.includes("NotFound") || msg.includes("NoSuchBucket")) {
      return NextResponse.json({
        ok: false,
        message: `Bucket "${config.bucket}" wasn't found — check the name and region`,
      });
    }

    return NextResponse.json({ ok: false, message: `Verification failed: ${msg}` });
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "backup-verify" });
