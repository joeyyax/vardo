import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { inboxItems, inboxItemFiles } from "@/lib/db/schema";
import {
  findEntityByIntakeToken,
  CLOUD_DOWNLOAD_MAX_BYTES,
  CLOUD_DOWNLOAD_TIMEOUT_MS,
  type IntakeEntity,
} from "@/lib/intake-email";
import { uploadBuffer } from "@/lib/r2";
import { resolveAssignee } from "@/lib/assignment";

// MIME types we accept (PDFs and images per design spec)
const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

/**
 * POST /api/webhooks/mailpace-inbound
 * Receives inbound email events from MailPace.
 */
export async function POST(request: NextRequest) {
  const payload = await request.text();

  // Verify Ed25519 signature if public key is configured
  const publicKey = process.env.MAILPACE_WEBHOOK_PUBLIC_KEY;
  if (publicKey) {
    const signature = request.headers.get("X-MailPace-Signature");
    if (!signature) {
      return NextResponse.json(
        { error: "Missing webhook signature" },
        { status: 400 }
      );
    }

    try {
      const isValid = crypto.verify(
        null,
        Buffer.from(payload),
        {
          key: Buffer.from(publicKey, "base64"),
          format: "der",
          type: "spki",
        },
        Buffer.from(signature, "base64")
      );

      if (!isValid) {
        return NextResponse.json(
          { error: "Invalid webhook signature" },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Signature verification failed" },
        { status: 400 }
      );
    }
  }

  let data: MailPaceInboundPayload;
  try {
    data = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return await handleInbound(data);
}

async function handleInbound(data: MailPaceInboundPayload) {
  try {
    // `to` is a string, may contain multiple comma-separated addresses
    const recipients = data.to.split(",").map((addr) => addr.trim());

    // Resolve entity (org, client, or project) from recipient addresses
    const entity = await resolveEntityFromRecipients(recipients);
    if (!entity) {
      // No matching entity — silently ignore
      return NextResponse.json({ received: true });
    }

    // Parse sender info
    const { name: fromName, address: fromAddress } = parseEmailAddress(data.from);

    // Filter attachments to accepted MIME types (arrive inline as base64)
    const validAttachments = (data.attachments ?? []).filter(
      (att) => ACCEPTED_MIME_TYPES.has(att.contentType)
    );

    if (validAttachments.length === 0) {
      // No valid attachments — silently ignore per design spec
      return NextResponse.json({ received: true });
    }

    // Build inbox item values with entity association
    const inboxValues: typeof inboxItems.$inferInsert = {
      organizationId: entity.orgId,
      externalEmailId: data.messageId || null,
      fromAddress,
      fromName,
      subject: data.subject || null,
      receivedAt: new Date(),
      status: "needs_review",
    };

    // Associate with client/project based on entity type
    if (entity.type === "client") {
      inboxValues.clientId = entity.id;
    } else if (entity.type === "project") {
      inboxValues.clientId = entity.clientId;
      inboxValues.projectId = entity.id;
    }

    inboxValues.assignedTo = await resolveAssignee({
      projectId: entity.type === "project" ? entity.id : undefined,
      clientId: entity.type === "client" ? entity.id : entity.type === "project" ? entity.clientId : undefined,
      orgId: entity.orgId,
    });

    // Create the inbox item
    const [inboxItem] = await db
      .insert(inboxItems)
      .values(inboxValues)
      .returning();

    // Process each attachment (already inline as base64)
    for (const attachment of validAttachments) {
      try {
        const buffer = Buffer.from(attachment.content, "base64");
        const safeFilename = (attachment.filename || "attachment").replace(
          /[^a-zA-Z0-9._-]/g,
          "_"
        );
        const r2Key = `${entity.orgId}/inbox/${inboxItem.id}/${safeFilename}`;

        await uploadBuffer(r2Key, buffer, attachment.contentType);

        await db.insert(inboxItemFiles).values({
          inboxItemId: inboxItem.id,
          name: attachment.filename || "attachment",
          sizeBytes: buffer.length,
          mimeType: attachment.contentType,
          r2Key,
          source: "attachment",
        });
      } catch (err) {
        console.error("Failed to process attachment:", attachment.filename, err);
        // Continue with remaining attachments
      }
    }

    // Extract files from cloud URLs in email body (best-effort)
    if (data.html) {
      try {
        const { extractCloudUrls, resolveDownloadUrl } = await import("@/lib/cloud-url");
        const cloudUrls = extractCloudUrls(data.html);

        for (const cloudUrl of cloudUrls) {
          try {
            const downloadUrl = resolveDownloadUrl(cloudUrl);
            const response = await fetch(downloadUrl, {
              signal: AbortSignal.timeout(CLOUD_DOWNLOAD_TIMEOUT_MS),
              redirect: "follow",
            });

            if (!response.ok) continue;

            const contentLength = response.headers.get("content-length");
            if (contentLength && parseInt(contentLength) > CLOUD_DOWNLOAD_MAX_BYTES) continue;

            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > CLOUD_DOWNLOAD_MAX_BYTES) continue;

            // Determine filename and MIME type
            const contentType = response.headers.get("content-type") || "application/octet-stream";
            const contentDisposition = response.headers.get("content-disposition");
            let filename = `${cloudUrl.service}-file`;
            if (contentDisposition) {
              const match = contentDisposition.match(/filename[*]?=(?:UTF-8''|"?)([^";\n]+)/i);
              if (match) filename = decodeURIComponent(match[1].trim());
            }
            const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
            const r2Key = `${entity.orgId}/inbox/${inboxItem.id}/${safeFilename}`;

            await uploadBuffer(r2Key, buffer, contentType);

            await db.insert(inboxItemFiles).values({
              inboxItemId: inboxItem.id,
              name: filename,
              sizeBytes: buffer.length,
              mimeType: contentType,
              r2Key,
              source: "cloud_url",
            });
          } catch {
            // Best-effort — skip failed cloud URL downloads
          }
        }
      } catch {
        // Cloud URL extraction not available or failed — continue
      }
    }

    return NextResponse.json({ received: true, itemId: inboxItem.id });
  } catch (error) {
    console.error("Error processing inbound email:", error);
    return NextResponse.json(
      { error: "Failed to process email" },
      { status: 500 }
    );
  }
}

/**
 * Extract the intake token from recipient addresses and find the entity.
 */
async function resolveEntityFromRecipients(
  recipients: string[]
): Promise<IntakeEntity | null> {
  for (const addr of recipients) {
    // Extract the local part before @intake.usescope.net
    const match = addr.match(/^<?([^@>]+)@intake\.usescope\.net>?$/i);
    if (!match) continue;

    const token = match[1];
    const entity = await findEntityByIntakeToken(token);
    if (entity) return entity;
  }
  return null;
}

/**
 * Parse "Name <email>" format into name and address components.
 */
function parseEmailAddress(from: string): { name: string | null; address: string } {
  const match = from.match(/^(.+?)\s*<(.+)>$/);
  if (match) {
    return { name: match[1].trim(), address: match[2].trim() };
  }
  return { name: null, address: from.trim() };
}

// Types for MailPace inbound webhook payload
type MailPaceInboundPayload = {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  messageId?: string;
  attachments?: {
    filename: string;
    content: string; // base64-encoded
    contentType: string;
  }[];
  headers?: unknown[];
};
