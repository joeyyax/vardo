import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export async function needsSetup(): Promise<boolean> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(user);
  return Number(count) === 0;
}
