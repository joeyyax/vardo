// Postgres leases for singleton loops. Every time comes from the database clock.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leaderLeases, type LeaderLeaseRow } from "@/lib/db/schema";
import { instanceId } from "./instance";

export const LEASE_TTL_MS = 60_000;

export type Lease = { name: string; holder: string; epoch: number };

/** False under VARDO_LEASES=off: singleton loops run in every process, as before leases. */
export function leasesEnabled(): boolean {
  return process.env.VARDO_LEASES !== "off";
}

/** Takes the lease when free or expired, renews it when already ours. Null while another holder's is live. */
export async function acquireLease(name: string, ttlMs = LEASE_TTL_MS, holder = instanceId()): Promise<Lease | null> {
  const rows = await db.execute<{ epoch: string | number }>(sql`
    INSERT INTO leader_lease (name, holder, epoch, expires_at, acquired_at, renewed_at)
    VALUES (${name}, ${holder}, 1, now() + ${ttlMs}::int * interval '1 millisecond', now(), now())
    ON CONFLICT (name) DO UPDATE SET
      holder = excluded.holder,
      epoch = CASE WHEN leader_lease.holder = excluded.holder THEN leader_lease.epoch ELSE leader_lease.epoch + 1 END,
      acquired_at = CASE WHEN leader_lease.holder = excluded.holder THEN leader_lease.acquired_at ELSE now() END,
      expires_at = excluded.expires_at,
      renewed_at = now()
    WHERE leader_lease.holder = excluded.holder OR leader_lease.expires_at <= now()
    RETURNING epoch`);
  const row = rows[0];
  return row ? { name, holder, epoch: Number(row.epoch) } : null;
}

/** Expires the lease now, so the next process takes it without waiting out the TTL. */
export async function releaseLease(lease: Lease): Promise<void> {
  await db.execute(sql`
    UPDATE leader_lease SET expires_at = now()
    WHERE name = ${lease.name} AND holder = ${lease.holder} AND epoch = ${lease.epoch} AND expires_at > now()`);
}

/** Whether this exact lease (holder and epoch) is still live. */
export async function checkFence(lease: Lease): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM leader_lease
    WHERE name = ${lease.name} AND holder = ${lease.holder} AND epoch = ${lease.epoch} AND expires_at > now()`);
  return rows.length > 0;
}

export type LeaseReading = LeaderLeaseRow & { live: boolean };

/** Every lease, with whether it's live by the database clock. */
export async function readLeases(): Promise<LeaseReading[]> {
  const rows = await db
    .select({
      name: leaderLeases.name,
      holder: leaderLeases.holder,
      epoch: leaderLeases.epoch,
      expiresAt: leaderLeases.expiresAt,
      acquiredAt: leaderLeases.acquiredAt,
      renewedAt: leaderLeases.renewedAt,
      live: sql<boolean>`${leaderLeases.expiresAt} > now()`,
    })
    .from(leaderLeases);
  return rows;
}
