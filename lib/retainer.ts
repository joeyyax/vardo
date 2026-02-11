import { db } from "@/lib/db";
import { retainerPeriods, clients } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

type BillingType = string | null;

/**
 * Check if a billing type is a retainer variant.
 */
export function isRetainerBilling(billingType: BillingType): boolean {
  return (
    billingType === "retainer_fixed" ||
    billingType === "retainer_capped" ||
    billingType === "retainer_uncapped"
  );
}

/**
 * Apply retainer logic to an hourly subtotal.
 * Returns the adjusted subtotal based on billing type.
 */
export function applyRetainerAdjustment(
  billingType: BillingType,
  hourlySubtotal: number,
  retainerAmount: number | null
): number {
  if (!retainerAmount || retainerAmount <= 0) return hourlySubtotal;

  switch (billingType) {
    case "retainer_fixed":
      // Flat fee regardless of hours
      return retainerAmount;
    case "retainer_capped":
      // Pay hourly up to the cap
      return Math.min(hourlySubtotal, retainerAmount);
    case "retainer_uncapped":
      // Pay hourly with a minimum floor
      return Math.max(hourlySubtotal, retainerAmount);
    default:
      return hourlySubtotal;
  }
}

/**
 * Get the most recent retainer period for a client.
 */
export async function getLatestRetainerPeriod(clientId: string) {
  return db.query.retainerPeriods.findFirst({
    where: eq(retainerPeriods.clientId, clientId),
    orderBy: [desc(retainerPeriods.periodEnd)],
  });
}

/**
 * Get the active retainer period for a client (if any).
 */
export async function getActiveRetainerPeriod(clientId: string) {
  return db.query.retainerPeriods.findFirst({
    where: and(
      eq(retainerPeriods.clientId, clientId),
      eq(retainerPeriods.status, "active")
    ),
    orderBy: [desc(retainerPeriods.periodStart)],
  });
}

/**
 * Create a retainer period record after generating an invoice.
 * Handles rollover from the previous period (max 1 period).
 */
export async function createRetainerPeriod({
  clientId,
  organizationId,
  periodStart,
  periodEnd,
  includedMinutes,
  usedMinutes,
  invoiceId,
}: {
  clientId: string;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  includedMinutes: number;
  usedMinutes: number;
  invoiceId: string;
}) {
  // Close any previous active period and calculate rollover
  const previousPeriod = await getActiveRetainerPeriod(clientId);
  let rolloverMinutes = 0;

  if (previousPeriod) {
    // Calculate unused minutes from previous period (rollover max 1 period)
    const previousUnused = Math.max(
      0,
      previousPeriod.includedMinutes +
        previousPeriod.rolloverMinutes -
        previousPeriod.usedMinutes
    );
    // Previous period's rollover does NOT cascade — only direct unused rolls over
    rolloverMinutes = Math.max(
      0,
      previousPeriod.includedMinutes - previousPeriod.usedMinutes
    );

    // Close previous period
    await db
      .update(retainerPeriods)
      .set({ status: "closed" })
      .where(eq(retainerPeriods.id, previousPeriod.id));
  }

  // Create new period
  const [period] = await db
    .insert(retainerPeriods)
    .values({
      clientId,
      organizationId,
      periodStart,
      periodEnd,
      includedMinutes,
      usedMinutes,
      rolloverMinutes,
      invoiceId,
      status: "active",
    })
    .returning();

  return period;
}

/**
 * Update the used minutes on the active retainer period for a client.
 * Called when time entries change.
 */
export async function updateRetainerUsage(
  clientId: string,
  usedMinutes: number
) {
  const activePeriod = await getActiveRetainerPeriod(clientId);
  if (!activePeriod) return null;

  const [updated] = await db
    .update(retainerPeriods)
    .set({ usedMinutes })
    .where(eq(retainerPeriods.id, activePeriod.id))
    .returning();

  return updated;
}

/**
 * Get retainer status summary for a client.
 */
export async function getRetainerStatus(clientId: string) {
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
  });

  if (!client || !isRetainerBilling(client.billingType)) {
    return null;
  }

  const activePeriod = await getActiveRetainerPeriod(clientId);

  const includedMinutes = client.includedMinutes || 0;
  const usedMinutes = activePeriod?.usedMinutes || 0;
  const rolloverMinutes = activePeriod?.rolloverMinutes || 0;
  const totalAvailable = includedMinutes + rolloverMinutes;
  const remainingMinutes = Math.max(0, totalAvailable - usedMinutes);
  const overageMinutes = Math.max(0, usedMinutes - totalAvailable);
  const usagePercent =
    totalAvailable > 0
      ? Math.min(100, Math.round((usedMinutes / totalAvailable) * 100))
      : 0;

  return {
    billingType: client.billingType,
    retainerAmount: client.retainerAmount,
    overageRate: client.overageRate,
    includedMinutes,
    usedMinutes,
    rolloverMinutes,
    totalAvailable,
    remainingMinutes,
    overageMinutes,
    usagePercent,
    periodStart: activePeriod?.periodStart || null,
    periodEnd: activePeriod?.periodEnd || null,
    hasActivePeriod: !!activePeriod,
  };
}
