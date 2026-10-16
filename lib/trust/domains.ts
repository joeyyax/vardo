// The instance domains the trust page can live on, and the host check that keeps it off every other.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { getInstanceConfig } from "@/lib/system-settings";
import { isHostname } from "@/lib/security/hostname";

/** Enabled hosts that serve a whole site, plus the console's own domain. Sorted. */
export async function listTrustDomains(): Promise<string[]> {
  const [rows, instance] = await Promise.all([
    db
      .selectDistinct({ domain: domains.domain })
      .from(domains)
      .where(and(eq(domains.enabled, true), isNull(domains.pathPrefix), isNull(domains.redirectTo))),
    getInstanceConfig().catch(() => null),
  ]);
  const hosts = new Set(rows.map((r) => r.domain.toLowerCase()));
  if (instance?.domain) hosts.add(instance.domain.toLowerCase());
  return [...hosts].filter(isHostname).sort();
}

/** The request's host without a port, lowercased. */
export function requestHost(headers: Pick<Headers, "get">): string | null {
  const raw = headers.get("host")?.trim().toLowerCase();
  if (!raw) return null;
  const host = raw.startsWith("[") ? raw : raw.replace(/:\d+$/, "");
  return host || null;
}

/** True only for the chosen trust domain. */
export function isTrustHost(host: string | null, domain: string | null): boolean {
  return !!host && !!domain && host === domain.toLowerCase();
}
