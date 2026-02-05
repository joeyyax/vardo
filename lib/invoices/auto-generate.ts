import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { generateInvoice } from "./generate";
import {
  startOfWeek,
  startOfMonth,
  startOfQuarter,
  subWeeks,
  subMonths,
  subQuarters,
  addDays,
  getDay,
  isAfter,
  format,
  parseISO,
} from "date-fns";

type ClientWithBilling = typeof clients.$inferSelect;

/**
 * Determine if a client is ready for auto-invoicing based on billing schedule.
 */
export function isClientReadyForInvoicing(
  client: ClientWithBilling,
  today: Date = new Date()
): boolean {
  // Must have auto-generate enabled
  if (!client.autoGenerateInvoices) return false;

  // Must have a billing frequency that isn't per-project
  if (!client.billingFrequency || client.billingFrequency === "per_project") {
    return false;
  }

  const lastInvoiced = client.lastInvoicedDate
    ? parseISO(client.lastInvoicedDate)
    : null;

  // Calculate next billing date
  const nextBillingDate = calculateNextBillingDate(client, lastInvoiced);

  if (!nextBillingDate) return false;

  // Ready if today is on or after the next billing date
  return !isAfter(nextBillingDate, today);
}

/**
 * Calculate the next billing date for a client.
 */
export function calculateNextBillingDate(
  client: ClientWithBilling,
  lastInvoiced: Date | null
): Date | null {
  const frequency = client.billingFrequency;
  if (!frequency || frequency === "per_project") return null;

  const baseDate = lastInvoiced || new Date();

  switch (frequency) {
    case "weekly": {
      const dayOfWeek = client.billingDayOfWeek ?? 1; // Default: Monday
      const next = addDays(baseDate, 7);
      // Adjust to the target day of week
      const currentDay = getDay(next);
      const daysToAdd = (dayOfWeek - currentDay + 7) % 7;
      return addDays(next, daysToAdd === 0 && lastInvoiced ? 7 : daysToAdd);
    }

    case "biweekly": {
      const dayOfWeek = client.billingDayOfWeek ?? 1;
      const next = addDays(baseDate, 14);
      const currentDay = getDay(next);
      const daysToAdd = (dayOfWeek - currentDay + 7) % 7;
      return addDays(next, daysToAdd === 0 && lastInvoiced ? 14 : daysToAdd);
    }

    case "monthly": {
      const dayOfMonth = client.billingDayOfMonth ?? 1;
      const next = new Date(baseDate);
      next.setMonth(next.getMonth() + 1);
      // Set to target day, handling month-end edge cases
      const lastDayOfMonth = new Date(
        next.getFullYear(),
        next.getMonth() + 1,
        0
      ).getDate();
      next.setDate(Math.min(dayOfMonth, lastDayOfMonth));
      return next;
    }

    case "quarterly": {
      const dayOfMonth = client.billingDayOfMonth ?? 1;
      const next = new Date(baseDate);
      next.setMonth(next.getMonth() + 3);
      const lastDayOfMonth = new Date(
        next.getFullYear(),
        next.getMonth() + 1,
        0
      ).getDate();
      next.setDate(Math.min(dayOfMonth, lastDayOfMonth));
      return next;
    }

    default:
      return null;
  }
}

/**
 * Calculate the billing period (from, to) for a client.
 */
export function calculateBillingPeriod(
  client: ClientWithBilling,
  today: Date = new Date()
): { from: string; to: string } | null {
  const frequency = client.billingFrequency;
  if (!frequency || frequency === "per_project") return null;

  const lastInvoiced = client.lastInvoicedDate
    ? parseISO(client.lastInvoicedDate)
    : null;

  // Period start: day after last invoice, or beginning of current period
  let periodStart: Date;
  let periodEnd: Date;

  if (lastInvoiced) {
    // Start from day after last invoiced date
    periodStart = addDays(lastInvoiced, 1);
  } else {
    // No previous invoice - use start of previous period
    switch (frequency) {
      case "weekly":
        periodStart = startOfWeek(subWeeks(today, 1), { weekStartsOn: 1 });
        break;
      case "biweekly":
        periodStart = startOfWeek(subWeeks(today, 2), { weekStartsOn: 1 });
        break;
      case "monthly":
        periodStart = startOfMonth(subMonths(today, 1));
        break;
      case "quarterly":
        periodStart = startOfQuarter(subQuarters(today, 1));
        break;
      default:
        return null;
    }
  }

  // Period end: end of the billing cycle before today
  switch (frequency) {
    case "weekly":
      // End at the end of the previous week (or yesterday if mid-week)
      periodEnd = subWeeks(startOfWeek(today, { weekStartsOn: 1 }), 0);
      periodEnd = addDays(periodEnd, -1); // Last day of previous week
      if (isAfter(periodStart, periodEnd)) {
        // If start is after end, adjust
        periodEnd = addDays(today, -1);
      }
      break;

    case "biweekly":
      periodEnd = addDays(today, -1);
      break;

    case "monthly":
      periodEnd = addDays(startOfMonth(today), -1); // Last day of previous month
      if (isAfter(periodStart, periodEnd)) {
        periodEnd = addDays(today, -1);
      }
      break;

    case "quarterly":
      periodEnd = addDays(startOfQuarter(today), -1);
      if (isAfter(periodStart, periodEnd)) {
        periodEnd = addDays(today, -1);
      }
      break;

    default:
      return null;
  }

  // Ensure period is valid
  if (isAfter(periodStart, periodEnd)) {
    return null;
  }

  return {
    from: format(periodStart, "yyyy-MM-dd"),
    to: format(periodEnd, "yyyy-MM-dd"),
  };
}

/**
 * Get all clients across all organizations that are ready for auto-invoicing.
 */
export async function getClientsReadyForInvoicing(): Promise<
  Array<{ client: ClientWithBilling; orgId: string }>
> {
  const allClients = await db.query.clients.findMany({
    where: and(
      eq(clients.autoGenerateInvoices, true),
      isNotNull(clients.billingFrequency)
    ),
  });

  const today = new Date();
  const readyClients: Array<{ client: ClientWithBilling; orgId: string }> = [];

  for (const client of allClients) {
    if (
      client.billingFrequency !== "per_project" &&
      isClientReadyForInvoicing(client, today)
    ) {
      readyClients.push({
        client,
        orgId: client.organizationId,
      });
    }
  }

  return readyClients;
}

/**
 * Generate an auto-invoice for a client and update lastInvoicedDate.
 */
export async function generateScheduledInvoice(
  client: ClientWithBilling,
  orgId: string
): Promise<{
  success: boolean;
  invoiceId?: string;
  error?: string;
}> {
  try {
    const period = calculateBillingPeriod(client);

    if (!period) {
      return {
        success: false,
        error: "Could not calculate billing period",
      };
    }

    // Generate the invoice
    const result = await generateInvoice(
      orgId,
      client.id,
      period.from,
      period.to
    );

    // Update lastInvoicedDate
    await db
      .update(clients)
      .set({
        lastInvoicedDate: period.to,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, client.id));

    return {
      success: true,
      invoiceId: result.invoice.id,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Run auto-invoice generation for all eligible clients.
 * Returns summary of results.
 */
export async function runAutoInvoiceGeneration(): Promise<{
  processed: number;
  successful: number;
  failed: number;
  results: Array<{
    clientId: string;
    clientName: string;
    success: boolean;
    invoiceId?: string;
    error?: string;
  }>;
}> {
  const readyClients = await getClientsReadyForInvoicing();

  const results: Array<{
    clientId: string;
    clientName: string;
    success: boolean;
    invoiceId?: string;
    error?: string;
  }> = [];

  for (const { client, orgId } of readyClients) {
    const result = await generateScheduledInvoice(client, orgId);

    results.push({
      clientId: client.id,
      clientName: client.name,
      ...result,
    });
  }

  return {
    processed: results.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}
