import { createHmac, timingSafeEqual } from "crypto";
import type { EmailProviderConfig } from "@/lib/system-settings";

export const POUCH_DEFAULT_BASE_URL = "https://pouch.email";

/** Webhook timestamps older than this are rejected. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type PouchMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo?: string;
};

export type PouchSendResult = { success: boolean; messageId?: string; error?: string };

export type PouchDeliveryStatus = "delivered" | "bounced" | "complained";

export function pouchBaseUrl(config: Pick<EmailProviderConfig, "baseUrl">): string {
  return (config.baseUrl?.trim() || POUCH_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** The `error.message` from a Pouch error body, or null. */
async function pouchErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : null;
  } catch {
    return null;
  }
}

export async function sendViaPouch(
  config: EmailProviderConfig,
  msg: PouchMessage,
): Promise<PouchSendResult> {
  if (!config.apiKey) return { success: false, error: "Pouch API key not configured" };

  const res = await fetch(`${pouchBaseUrl(config)}/v1/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      tags: ["vardo"],
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const message = await pouchErrorMessage(res);
    return { success: false, error: message ? `Pouch: ${message}` : `Pouch: ${res.status}` };
  }

  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  return { success: true, messageId: typeof body?.id === "string" ? body.id : undefined };
}

type PouchDomain = { name: string; status: string };

/** Checks the key and that the from address's domain is verified in Pouch. */
export async function verifyPouch(config: EmailProviderConfig): Promise<{ ok: boolean; message: string }> {
  if (!config.apiKey) return { ok: false, message: "Pouch API key is missing" };
  const domainName = config.fromEmail?.split("@")[1]?.toLowerCase();
  if (!domainName) return { ok: false, message: "From email isn't set" };

  const base = pouchBaseUrl(config);
  let cursor: string | null = null;
  // Ten pages of 200 covers any realistic account.
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${base}/v1/domains`);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    if (res.status === 401) return { ok: false, message: "Pouch rejected the API key" };
    if (!res.ok) {
      const message = await pouchErrorMessage(res);
      return { ok: false, message: `Pouch returned ${res.status}${message ? `: ${message}` : ""}` };
    }

    const body = (await res.json()) as { data?: PouchDomain[]; next_cursor?: string | null };
    const domain = body.data?.find((d) => d.name.toLowerCase() === domainName);
    if (domain) {
      if (domain.status === "verified") {
        return { ok: true, message: `Connected to Pouch. ${domainName} is verified.` };
      }
      return { ok: false, message: `${domainName} is ${domain.status} in Pouch. Finish its DNS setup there.` };
    }
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
  }

  return { ok: false, message: `${domainName} isn't in Pouch, or this key can't send from it` };
}

/** Checks `X-Signature` (`sha256=<hex>` over `<timestamp>.<body>`) and the timestamp's age. */
export function verifyPouchSignature(opts: {
  secret: string;
  body: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
}): boolean {
  const { secret, body, signature, timestamp } = opts;
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;

  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const EVENT_STATUS: Record<string, PouchDeliveryStatus> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

/** The message id and delivery status a webhook reports, or null for events Vardo ignores. */
export function parsePouchEvent(payload: unknown): { messageId: string; status: PouchDeliveryStatus } | null {
  if (!payload || typeof payload !== "object") return null;
  const { type, data } = payload as { type?: unknown; data?: { id?: unknown } };
  const status = typeof type === "string" ? EVENT_STATUS[type] : undefined;
  const messageId = data?.id;
  if (!status || typeof messageId !== "string") return null;
  return { messageId, status };
}
