import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { db } from "@/lib/db";
import { inboxItems, inboxItemFiles } from "@/lib/db/schema";
import {
  findEntityByIntakeToken,
  CLOUD_DOWNLOAD_MAX_BYTES,
  CLOUD_DOWNLOAD_TIMEOUT_MS,
  type IntakeEntity,
} from "@/lib/intake-email";
import { uploadBuffer } from "@/lib/r2";

const resend = new Resend(process.env.RESEND_API_KEY);

// MIME types we accept (PDFs and images per design spec)
const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

/**
 * POST /api/webhooks/resend-inbound
 * Receives inbound email events from Resend.
 */
export async function POST(request: NextRequest) {
  // Verify webhook signature if secret is configured
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (webhookSecret) {
    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return NextResponse.json(
        { error: "Missing webhook signature headers" },
        { status: 400 }
      );
    }

    try {
      const payload = await request.text();
      resend.webhooks.verify({
        payload,
        headers: {
          id: svixId,
          timestamp: svixTimestamp,
          signature: svixSignature,
        },
        webhookSecret,
      });
      // Parse the verified payload
      const event = JSON.parse(payload);
      return await handleEvent(event);
    } catch {
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 400 }
      );
    }
  }

  // No secret configured — parse body directly (dev mode)
  const event = await request.json();
  return await handleEvent(event);
}

async function handleEvent(event: ResendInboundEvent) {
  if (event.type !== "email.received") {
    return NextResponse.json({ received: true });
  }

  try {
    const { data } = event;

    // Resolve entity (org, client, or project) from recipient addresses
    const entity = await resolveEntityFromRecipients(data.to);
    if (!entity) {
      // No matching entity — silently ignore
      return NextResponse.json({ received: true });
    }

    // Parse sender info
    const { name: fromName, address: fromAddress } = parseEmailAddress(data.from);

    // Fetch attachment metadata from Resend
    const attachmentResponse = await resend.emails.receiving.attachments.list({
      emailId: data.email_id,
    });

    // SDK returns { data: { object: 'list', data: Attachment[] } | null }
    const attachmentList = attachmentResponse.data?.data ?? [];

    // Filter to accepted MIME types only
    const validAttachments = attachmentList.filter(
      (att) => ACCEPTED_MIME_TYPES.has(att.content_type)
    );

    if (validAttachments.length === 0) {
      // No valid attachments — silently ignore per design spec
      return NextResponse.json({ received: true });
    }

    // Build inbox item values with entity association
    const inboxValues: typeof inboxItems.$inferInsert = {
      organizationId: entity.orgId,
      resendEmailId: data.email_id,
      fromAddress,
      fromName,
      subject: data.subject || null,
      receivedAt: new Date(data.created_at),
      status: "needs_review",
    };

    // Associate with client/project based on entity type
    if (entity.type === "client") {
      inboxValues.clientId = entity.id;
    } else if (entity.type === "project") {
      inboxValues.clientId = entity.clientId;
      inboxValues.projectId = entity.id;
    }

    // Create the inbox item
    const [inboxItem] = await db
      .insert(inboxItems)
      .values(inboxValues)
      .returning();

    // Download each attachment, upload to R2, and create file records
    for (const attachment of validAttachments) {
      try {
        const response = await fetch(attachment.download_url);
        if (!response.ok) continue;

        const buffer = Buffer.from(await response.arrayBuffer());
        const safeFilename = (attachment.filename || "attachment").replace(
          /[^a-zA-Z0-9._-]/g,
          "_"
        );
        const r2Key = `${entity.orgId}/inbox/${inboxItem.id}/${safeFilename}`;

        await uploadBuffer(r2Key, buffer, attachment.content_type);

        await db.insert(inboxItemFiles).values({
          inboxItemId: inboxItem.id,
          name: attachment.filename || "attachment",
          sizeBytes: attachment.size ?? buffer.length,
          mimeType: attachment.content_type,
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

// Types for Resend inbound webhook payload
type ResendInboundEvent = {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
    to: string[];
    subject: string;
    html?: string;
    attachments: {
      id: string;
      filename: string;
      content_type: string;
    }[];
  };
};
