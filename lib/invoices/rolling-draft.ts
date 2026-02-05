import { db } from "@/lib/db";
import { invoices, invoiceLineItems, clients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  generateInvoiceNumber,
  generatePublicToken,
  fetchBillableEntries,
  groupEntriesByProjectTask,
} from "./generate";
import { resolveRate, buildRateChain } from "./resolve-rate";
import { organizations } from "@/lib/db/schema";
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  format,
  parseISO,
  addDays,
} from "date-fns";

type ClientWithBilling = typeof clients.$inferSelect;

/**
 * Calculate the CURRENT billing period for rolling drafts.
 * Unlike calculateBillingPeriod (for completed periods), this returns
 * the period that includes today.
 */
function calculateCurrentBillingPeriod(
  client: ClientWithBilling,
  today: Date = new Date()
): { from: string; to: string } | null {
  const frequency = client.billingFrequency;
  if (!frequency || frequency === "per_project") return null;

  const lastInvoiced = client.lastInvoicedDate
    ? parseISO(client.lastInvoicedDate)
    : null;

  let periodStart: Date;
  let periodEnd: Date;

  if (lastInvoiced) {
    // Start from day after last invoiced date
    periodStart = addDays(lastInvoiced, 1);
  } else {
    // No previous invoice - use start of current period
    switch (frequency) {
      case "weekly":
        periodStart = startOfWeek(today, { weekStartsOn: 1 });
        break;
      case "biweekly":
        // Start of current 2-week period (approximate)
        periodStart = startOfWeek(today, { weekStartsOn: 1 });
        break;
      case "monthly":
        periodStart = startOfMonth(today);
        break;
      case "quarterly":
        periodStart = startOfQuarter(today);
        break;
      default:
        return null;
    }
  }

  // Period end: end of current billing cycle
  switch (frequency) {
    case "weekly":
      periodEnd = endOfWeek(today, { weekStartsOn: 1 });
      break;
    case "biweekly":
      periodEnd = endOfWeek(addDays(startOfWeek(today, { weekStartsOn: 1 }), 13), { weekStartsOn: 1 });
      break;
    case "monthly":
      periodEnd = endOfMonth(today);
      break;
    case "quarterly":
      periodEnd = endOfQuarter(today);
      break;
    default:
      return null;
  }

  return {
    from: format(periodStart, "yyyy-MM-dd"),
    to: format(periodEnd, "yyyy-MM-dd"),
  };
}

/**
 * Update or create a rolling draft invoice for a client with auto-invoicing enabled.
 * Called when a time entry is created/updated/deleted for that client.
 */
export async function updateRollingDraftInvoice(
  orgId: string,
  clientId: string
): Promise<{ invoiceId: string | null; created: boolean }> {
  // Fetch client to check if auto-invoicing is enabled
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
  });

  if (!client || !client.autoGenerateInvoices || !client.billingFrequency) {
    return { invoiceId: null, created: false };
  }

  // Calculate the current billing period (includes today)
  const period = calculateCurrentBillingPeriod(client);
  if (!period) {
    return { invoiceId: null, created: false };
  }

  // Find existing draft invoice for this client and period
  const existingInvoice = await db.query.invoices.findFirst({
    where: and(
      eq(invoices.organizationId, orgId),
      eq(invoices.clientId, clientId),
      eq(invoices.status, "draft"),
      eq(invoices.periodStart, period.from),
      eq(invoices.periodEnd, period.to)
    ),
  });

  // Fetch org for default rate
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
  });

  if (!org) {
    return { invoiceId: null, created: false };
  }

  // Fetch all billable entries for the period
  const entries = await fetchBillableEntries(orgId, clientId, period.from, period.to);

  // If no entries, delete existing draft if any (or do nothing)
  if (entries.length === 0) {
    if (existingInvoice) {
      // Delete the empty draft
      await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, existingInvoice.id));
      await db.delete(invoices).where(eq(invoices.id, existingInvoice.id));
    }
    return { invoiceId: null, created: false };
  }

  // Group entries and calculate line items
  const groups = groupEntriesByProjectTask(entries);

  let subtotal = 0;
  let totalMinutes = 0;
  const lineItemsData: Array<{
    projectId: string | null;
    projectName: string;
    taskId: string | null;
    taskName: string | null;
    description: string | null;
    minutes: number;
    rate: number;
    amount: number;
    entryIds: string[];
  }> = [];

  for (const group of groups) {
    const representativeEntry = group.entries[0];

    const rateChain = buildRateChain(
      { defaultRate: org.defaultRate },
      { rateOverride: representativeEntry.client.rateOverride },
      representativeEntry.project
        ? { rateOverride: representativeEntry.project.rateOverride }
        : null,
      representativeEntry.task
        ? { rateOverride: representativeEntry.task.rateOverride }
        : null
    );

    const rate = resolveRate(rateChain) || 0;
    const amount = Math.round((group.totalMinutes / 60) * rate);

    let description: string | null = null;
    if (group.descriptions.length > 0) {
      const uniqueDescriptions = [...new Set(group.descriptions)].slice(0, 3);
      description = uniqueDescriptions.join("; ");
    }

    lineItemsData.push({
      projectId: group.projectId,
      projectName: group.projectName,
      taskId: group.taskId,
      taskName: group.taskName,
      description,
      minutes: group.totalMinutes,
      rate,
      amount,
      entryIds: group.entries.map((e) => e.id),
    });

    subtotal += amount;
    totalMinutes += group.totalMinutes;
  }

  // Calculate due date from payment terms
  const paymentTerms = client.paymentTermsDays ?? org.defaultPaymentTermsDays ?? 30;
  const dueDate = format(addDays(parseISO(period.to), paymentTerms), "yyyy-MM-dd");

  if (existingInvoice) {
    // Update existing draft
    await db.transaction(async (tx) => {
      // Delete old line items
      await tx
        .delete(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, existingInvoice.id));

      // Update invoice totals and due date
      await tx
        .update(invoices)
        .set({
          subtotal,
          totalMinutes,
          dueDate,
        })
        .where(eq(invoices.id, existingInvoice.id));

      // Insert new line items
      await tx.insert(invoiceLineItems).values(
        lineItemsData.map((item) => ({
          invoiceId: existingInvoice.id,
          projectId: item.projectId,
          projectName: item.projectName,
          taskId: item.taskId,
          taskName: item.taskName,
          description: item.description,
          minutes: item.minutes,
          rate: item.rate,
          amount: item.amount,
          entryIds: item.entryIds,
        }))
      );
    });

    return { invoiceId: existingInvoice.id, created: false };
  } else {
    // Create new draft invoice
    const invoiceNumber = await generateInvoiceNumber(orgId);
    const publicToken = generatePublicToken();

    const result = await db.transaction(async (tx) => {
      const [invoice] = await tx
        .insert(invoices)
        .values({
          organizationId: orgId,
          clientId,
          invoiceNumber,
          status: "draft",
          isAutoGenerated: true,
          periodStart: period.from,
          periodEnd: period.to,
          subtotal,
          totalMinutes,
          publicToken,
          dueDate,
        })
        .returning();

      await tx.insert(invoiceLineItems).values(
        lineItemsData.map((item) => ({
          invoiceId: invoice.id,
          projectId: item.projectId,
          projectName: item.projectName,
          taskId: item.taskId,
          taskName: item.taskName,
          description: item.description,
          minutes: item.minutes,
          rate: item.rate,
          amount: item.amount,
          entryIds: item.entryIds,
        }))
      );

      return invoice;
    });

    return { invoiceId: result.id, created: true };
  }
}
