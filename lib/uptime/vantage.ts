// Vantage points: this instance's local one, with its signing key, and the external ones linked later.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { uptimeVantages, type UptimeVantageRow } from "@/lib/db/schema";
import { decryptSystem, encryptSystem } from "@/lib/crypto/encrypt";
import { generateKeyPair, type VantagePoint } from "./core";

export const LOCAL_VANTAGE_ID = "local";

/** The local vantage row, created with a fresh keypair on first use. */
export async function ensureLocalVantage(): Promise<UptimeVantageRow> {
  const existing = await db.query.uptimeVantages.findFirst({ where: eq(uptimeVantages.id, LOCAL_VANTAGE_ID) });
  if (existing) return existing;
  const keys = generateKeyPair();
  await db
    .insert(uptimeVantages)
    .values({
      id: LOCAL_VANTAGE_ID,
      name: "This instance",
      kind: "local",
      publicKey: keys.publicKey,
      privateKeyEncrypted: encryptSystem(keys.privateKey),
    })
    .onConflictDoNothing();
  const row = await db.query.uptimeVantages.findFirst({ where: eq(uptimeVantages.id, LOCAL_VANTAGE_ID) });
  if (!row) throw new Error("Local vantage point was not created");
  return row;
}

/** The local vantage point's private key, decrypted. */
export async function localSigningKey(): Promise<string> {
  const row = await ensureLocalVantage();
  if (!row.privateKeyEncrypted) throw new Error("Local vantage point has no signing key");
  return decryptSystem(row.privateKeyEncrypted);
}

export function toVantagePoint(row: UptimeVantageRow): VantagePoint {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "local" ? "local" : "external",
    ...(row.location ? { location: row.location } : {}),
  };
}

/** Every vantage point, the local one first. */
export async function listVantagePoints(): Promise<VantagePoint[]> {
  await ensureLocalVantage();
  const rows = await db.select().from(uptimeVantages);
  return rows.sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local") || a.name.localeCompare(b.name)).map(toVantagePoint);
}
