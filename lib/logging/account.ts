// Each organization's VictoriaLogs tenant. AccountID 0 holds logs with no organization, which no read can name.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";

/** Docker label carrying a container's AccountID. The log shipper routes each container by it. */
export const LOG_ACCOUNT_LABEL = "vardo.log.account";

/** Throws unless `id` is an AccountID an organization can hold. */
export function requireAccount(id: number | null | undefined): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 0xffff_ffff) {
    throw new Error("VictoriaLogs read requires an organization's log account");
  }
  return id;
}

/** Headers scoping a VictoriaLogs request to one organization. */
export function accountHeaders(accountId: number): Record<string, string> {
  return { AccountID: String(requireAccount(accountId)), ProjectID: "0" };
}

// Ids never change once assigned.
const cache = new Map<string, number>();

/** The organization's AccountID. Throws on a blank or unknown organization. */
export async function logAccountId(organizationId: string): Promise<number> {
  const id = organizationId?.trim();
  if (!id) throw new Error("VictoriaLogs read requires an organization id");
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, id),
    columns: { logAccountId: true },
  });
  const account = requireAccount(org?.logAccountId);
  cache.set(id, account);
  return account;
}
