// Single-use sign-in tickets this instance issues to a linked peer for a user with the same verified email.

import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { memberships, meshPeers, user } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { isAuthMethodEnabled } from "@/lib/config/auth-methods";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { VERIFY_EMAIL_HINT } from "@/lib/auth/verify-email-paths";

export const INSTANCE_TICKET_PATH = "/api/v1/mesh/instance-ticket";
/** Better Auth serves the redeem endpoint under its own base path. */
export const REDEEM_PATH = "/api/auth/instance-ticket";
export const TICKET_TTL_MS = 60_000;
export const DEFAULT_LANDING = "/projects";

const TICKET_RE = /^[0-9a-f]{64}$/;

/** A same-origin path, or the default landing page. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return DEFAULT_LANDING;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return DEFAULT_LANDING;
  return /^[\w\-./?=&%~+]*$/.test(raw) ? raw : DEFAULT_LANDING;
}

export const ticketRequestSchema = z
  .object({
    email: z.string().email().max(320),
    // The originating session passed a second factor.
    secondFactor: z.boolean(),
    next: z.string().max(512).optional(),
    organizationId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type TicketRequest = z.infer<typeof ticketRequestSchema>;

const recordSchema = z.object({
  userId: z.string(),
  email: z.string(),
  peerId: z.string(),
  secondFactor: z.boolean(),
  next: z.string(),
  organizationId: z.string().nullable(),
  expiresAt: z.number(),
});

type TicketRecord = z.infer<typeof recordSchema>;

export type TicketPeer = { id: string; name: string; acceptInstanceSignin: boolean };

export class TicketError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 503,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

function ticketKey(ticket: string): string {
  return `instance-ticket:${createHash("sha256").update(ticket).digest("hex")}`;
}

/** Whether this instance puts a second factor in front of `target`'s sign-ins. */
export function requiresSecondFactor(target: { twoFactorEnabled: boolean | null }): boolean {
  return !!target.twoFactorEnabled && isAuthMethodEnabled("totp");
}

async function here(): Promise<string> {
  return (await getInstanceDisplayName()) ?? "this instance";
}

async function verifiedUser(email: string) {
  const row = await db.query.user.findFirst({
    where: sql`lower(${user.email}) = ${email.toLowerCase()}`,
    columns: { id: true, email: true, emailVerified: true, twoFactorEnabled: true },
  });
  return row?.emailVerified ? row : null;
}

/** This console's browser-facing origin. */
export function consoleOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/** Issues a ticket for `peer`. The caller has checked the mesh signature and nonce. */
export async function issueTicket(
  peer: TicketPeer,
  request: TicketRequest,
  now: number = Date.now(),
): Promise<{ url: string; expiresAt: number }> {
  const name = await here();
  if (!peer.acceptInstanceSignin) {
    throw new TicketError(`${name} doesn't accept sign-ins from ${peer.name}. An admin there can turn it on.`, 403);
  }

  const target = await verifiedUser(request.email);
  if (!target) throw new TicketError(`No user with that verified email on ${name}. ${VERIFY_EMAIL_HINT} there.`, 403);

  if (requiresSecondFactor(target) && !request.secondFactor) {
    throw new TicketError(
      `Your account on ${name} uses two-factor and this session didn't pass it. Sign in to ${name} directly.`,
      403,
    );
  }

  const ticket = randomBytes(32).toString("hex");
  const record: TicketRecord = {
    userId: target.id,
    email: target.email,
    peerId: peer.id,
    secondFactor: request.secondFactor,
    next: safeNext(request.next),
    organizationId: request.organizationId ?? null,
    expiresAt: now + TICKET_TTL_MS,
  };

  const stored = await redis
    .set(ticketKey(ticket), JSON.stringify(record), "PX", TICKET_TTL_MS, "NX")
    .catch(() => null);
  if (stored !== "OK") throw new TicketError(`${name} couldn't store the sign-in ticket. Try again.`, 503);

  return { url: `${consoleOrigin()}${REDEEM_PATH}?ticket=${ticket}`, expiresAt: record.expiresAt };
}

export type Redeemed = {
  userId: string;
  peer: { id: string; name: string; instanceId: string };
  next: string;
  organizationId: string | null;
};

const EXPIRED = "That sign-in link has expired or was already used. Start again from the other instance.";

/** Consumes `ticket` once and re-checks everything it was issued on. */
export async function redeemTicket(ticket: string, now: number = Date.now()): Promise<Redeemed> {
  if (!TICKET_RE.test(ticket)) throw new TicketError("That sign-in link isn't valid.", 400);

  let raw: string | null;
  try {
    raw = await redis.getdel(ticketKey(ticket));
  } catch {
    throw new TicketError("Sign-in links are unavailable right now. Try again.", 503);
  }
  if (!raw) throw new TicketError(EXPIRED, 403);

  let record: TicketRecord;
  try {
    record = recordSchema.parse(JSON.parse(raw));
  } catch {
    throw new TicketError("That sign-in link isn't valid.", 400);
  }
  if (record.expiresAt <= now) throw new TicketError(EXPIRED, 403);

  const name = await here();
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.id, record.peerId),
    columns: { id: true, name: true, instanceId: true, connectionType: true, acceptInstanceSignin: true },
  });
  if (!peer || peer.connectionType !== "direct" || !peer.acceptInstanceSignin) {
    throw new TicketError(`${name} no longer accepts sign-ins from that instance.`, 403);
  }

  const target = await db.query.user.findFirst({
    where: eq(user.id, record.userId),
    columns: { id: true, email: true, emailVerified: true, twoFactorEnabled: true },
  });
  if (!target || !target.emailVerified || target.email.toLowerCase() !== record.email.toLowerCase()) {
    throw new TicketError(`No user with that verified email on ${name}.`, 403);
  }
  if (requiresSecondFactor(target) && !record.secondFactor) {
    throw new TicketError(`Your account on ${name} uses two-factor. Sign in to ${name} directly.`, 403);
  }

  let organizationId: string | null = null;
  if (record.organizationId) {
    const member = await db.query.memberships.findFirst({
      where: and(eq(memberships.userId, target.id), eq(memberships.organizationId, record.organizationId)),
      columns: { organizationId: true },
    });
    organizationId = member?.organizationId ?? null;
  }

  return {
    userId: target.id,
    peer: { id: peer.id, name: peer.name, instanceId: peer.instanceId },
    next: safeNext(record.next),
    organizationId,
  };
}

/** The org an instance sign-in is logged under: the landing org, else the user's first. */
export async function activityOrgFor(userId: string, preferred: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const first = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
    columns: { organizationId: true },
    orderBy: [asc(memberships.createdAt)],
  });
  return first?.organizationId ?? null;
}
