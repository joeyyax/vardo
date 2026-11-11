// UPS servers in the database: the admin's view, the poller's target and its state.

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { upsServers, type UpsServerRow } from "@/lib/db/schema";
import { decryptSystem, encryptSystem } from "@/lib/crypto/encrypt";
import type { NutTarget } from "./client";
import { upsHealth, type UpsHealth, type UpsState } from "./status";

/** What the API returns. The password never leaves the server. */
export type UpsServerView = {
  id: string;
  name: string;
  host: string;
  port: number;
  upsName: string;
  username: string | null;
  hasPassword: boolean;
  tls: boolean;
  enabled: boolean;
  onBatteryGraceSec: number;
  health: UpsHealth;
  state: UpsState | null;
  createdAt: string;
  updatedAt: string;
};

export function toView(row: UpsServerRow): UpsServerView {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    upsName: row.upsName,
    username: row.username,
    hasPassword: !!row.password,
    tls: row.tls,
    enabled: row.enabled,
    onBatteryGraceSec: row.onBatteryGraceSec,
    health: row.enabled ? upsHealth(row.state) : "unknown",
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function encryptPassword(password: string | null | undefined): string | null {
  return password ? encryptSystem(password) : null;
}

/** The connection details with the password decrypted. */
export function targetOf(row: Pick<UpsServerRow, "host" | "port" | "username" | "password" | "tls">): NutTarget {
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password ? decryptSystem(row.password) : null,
    tls: row.tls,
  };
}

export async function listUpsServers(): Promise<UpsServerRow[]> {
  return db.select().from(upsServers).orderBy(asc(upsServers.name), asc(upsServers.createdAt));
}

export async function getUpsServer(id: string): Promise<UpsServerRow | null> {
  const [row] = await db.select().from(upsServers).where(eq(upsServers.id, id));
  return row ?? null;
}

/** Saves the poller's state without touching `updatedAt`, which tracks admin edits. False when the row is gone or paused. */
export async function saveUpsState(id: string, state: UpsState): Promise<boolean> {
  const saved = await db.update(upsServers).set({ state }).where(and(eq(upsServers.id, id), eq(upsServers.enabled, true))).returning({ id: upsServers.id });
  return saved.length > 0;
}
