import { db } from "@/lib/db";
import {
  invoices,
  invoiceLineItems,
  timeEntries,
  organizations,
  clients,
} from "@/lib/db/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { resolveRate, buildRateChain } from "./resolve-rate";
import { resolveEntryBillable } from "@/lib/entries/resolve-billable";
import { randomBytes } from "crypto";

export interface InvoiceGenerationOptions {
  includeSummaries?: boolean;
}

export interface TimeEntryForInvoice {
  id: string;
  description: string | null;
  date: string;
  durationMinutes: number;
  isBillableOverride: boolean | null;
  clientId: string;
  projectId: string | null;
  taskId: string | null;
  client: {
    id: string;
    name: string;
    isBillable: boolean | null;
    rateOverride: number | null;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
    isBillable: boolean | null;
    rateOverride: number | null;
  } | null;
  task: {
    id: string;
    name: string;
    isBillable: boolean | null;
    rateOverride: number | null;
  } | null;
}

export interface LineItemGroup {
  projectId: string | null;
  projectName: string;
  taskId: string | null;
  taskName: string | null;
  entries: TimeEntryForInvoice[];
  totalMinutes: number;
  descriptions: string[];
}

/**
 * Generate the next invoice number for an organization.
 * Format: INV-YYYY-NNN (e.g., INV-2024-001)
 */
export async function generateInvoiceNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;

  // Get the highest invoice number for this year
  const result = await db
    .select({
      maxNumber: sql<string>`max(${invoices.invoiceNumber})`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, orgId),
        sql`${invoices.invoiceNumber} like ${prefix + "%"}`
      )
    );

  const maxInvoice = result[0]?.maxNumber;

  if (!maxInvoice) {
    return `${prefix}001`;
  }

  // Extract the number part and increment
  const numberPart = maxInvoice.substring(prefix.length);
  const nextNumber = parseInt(numberPart, 10) + 1;

  return `${prefix}${nextNumber.toString().padStart(3, "0")}`;
}

/**
 * Generate a secure public token for invoice viewing.
 */
export function generatePublicToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Group time entries by project and task for invoice line items.
 */
export function groupEntriesByProjectTask(
  entries: TimeEntryForInvoice[]
): LineItemGroup[] {
  const groups = new Map<string, LineItemGroup>();

  for (const entry of entries) {
    // Create a unique key for project+task combination
    const key = `${entry.projectId || "no-project"}|${entry.taskId || "no-task"}`;

    if (!groups.has(key)) {
      groups.set(key, {
        projectId: entry.projectId,
        projectName: entry.project?.name || entry.client.name,
        taskId: entry.taskId,
        taskName: entry.task?.name || null,
        entries: [],
        totalMinutes: 0,
        descriptions: [],
      });
    }

    const group = groups.get(key)!;
    group.entries.push(entry);
    group.totalMinutes += entry.durationMinutes;

    if (entry.description?.trim()) {
      group.descriptions.push(entry.description.trim());
    }
  }

  // Sort by project name, then task name
  return Array.from(groups.values()).sort((a, b) => {
    const projectCompare = a.projectName.localeCompare(b.projectName);
    if (projectCompare !== 0) return projectCompare;
    if (!a.taskName && !b.taskName) return 0;
    if (!a.taskName) return -1;
    if (!b.taskName) return 1;
    return a.taskName.localeCompare(b.taskName);
  });
}

/**
 * Fetch billable time entries for a client within a date range.
 */
export async function fetchBillableEntries(
  orgId: string,
  clientId: string,
  from: string,
  to: string
): Promise<TimeEntryForInvoice[]> {
  const entries = await db.query.timeEntries.findMany({
    where: and(
      eq(timeEntries.organizationId, orgId),
      eq(timeEntries.clientId, clientId),
      gte(timeEntries.date, from),
      lte(timeEntries.date, to)
    ),
    with: {
      client: true,
      project: true,
      task: true,
    },
    orderBy: [desc(timeEntries.date)],
  });

  // Filter to only billable entries
  return entries.filter((entry) => {
    const isBillable = resolveEntryBillable({
      isBillableOverride: entry.isBillableOverride,
      task: entry.task ? { isBillable: entry.task.isBillable } : null,
      project: entry.project ? { isBillable: entry.project.isBillable } : null,
      client: { isBillable: entry.client.isBillable },
    });
    return isBillable;
  });
}

/**
 * Generate an invoice for a client.
 */
export async function generateInvoice(
  orgId: string,
  clientId: string,
  from: string,
  to: string,
  _options: InvoiceGenerationOptions = {}
): Promise<{
  invoice: typeof invoices.$inferSelect;
  lineItems: (typeof invoiceLineItems.$inferSelect)[];
}> {
  // Fetch organization for default rate
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
  });

  if (!org) {
    throw new Error("Organization not found");
  }

  // Fetch client
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
  });

  if (!client) {
    throw new Error("Client not found or doesn't belong to organization");
  }

  // Fetch billable entries
  const entries = await fetchBillableEntries(orgId, clientId, from, to);

  if (entries.length === 0) {
    throw new Error("No billable entries found for the specified period");
  }

  // Group entries by project/task
  const groups = groupEntriesByProjectTask(entries);

  // Calculate line items with rates
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

  let subtotal = 0;
  let totalMinutes = 0;

  for (const group of groups) {
    // Get a representative entry to determine rate
    const representativeEntry = group.entries[0];

    // Build rate chain from the entry's hierarchy
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

    // Calculate amount: (minutes / 60) * (rate cents/hour) = cents
    const amount = Math.round((group.totalMinutes / 60) * rate);

    // Create description from entry descriptions (will be replaced by AI if enabled)
    let description: string | null = null;
    if (group.descriptions.length > 0) {
      // Take unique descriptions, max 3
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

  // Generate invoice number and public token
  const invoiceNumber = await generateInvoiceNumber(orgId);
  const publicToken = generatePublicToken();

  // Create invoice in a transaction
  return await db.transaction(async (tx) => {
    // Insert invoice
    const [invoice] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        clientId,
        invoiceNumber,
        status: "draft",
        periodStart: from,
        periodEnd: to,
        subtotal,
        totalMinutes,
        publicToken,
      })
      .returning();

    // Insert line items
    const createdLineItems = await tx
      .insert(invoiceLineItems)
      .values(
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
      )
      .returning();

    return { invoice, lineItems: createdLineItems };
  });
}

/**
 * Get an invoice with its line items.
 */
export async function getInvoiceWithLineItems(
  invoiceId: string,
  orgId: string
): Promise<{
  invoice: typeof invoices.$inferSelect;
  lineItems: (typeof invoiceLineItems.$inferSelect)[];
  client: typeof clients.$inferSelect;
  organization: typeof organizations.$inferSelect;
} | null> {
  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)),
    with: {
      lineItems: true,
      client: true,
      organization: true,
    },
  });

  if (!invoice) {
    return null;
  }

  return {
    invoice,
    lineItems: invoice.lineItems,
    client: invoice.client,
    organization: invoice.organization,
  };
}

/**
 * Get an invoice by its public token.
 */
export async function getInvoiceByToken(token: string): Promise<{
  invoice: typeof invoices.$inferSelect;
  lineItems: (typeof invoiceLineItems.$inferSelect)[];
  client: typeof clients.$inferSelect;
  organization: typeof organizations.$inferSelect;
} | null> {
  const invoice = await db.query.invoices.findFirst({
    where: eq(invoices.publicToken, token),
    with: {
      lineItems: true,
      client: true,
      organization: true,
    },
  });

  if (!invoice) {
    return null;
  }

  return {
    invoice,
    lineItems: invoice.lineItems,
    client: invoice.client,
    organization: invoice.organization,
  };
}

/**
 * Mark an invoice as viewed (update viewedAt timestamp).
 */
export async function markInvoiceViewed(invoiceId: string): Promise<void> {
  await db
    .update(invoices)
    .set({ viewedAt: new Date(), status: "viewed" })
    .where(
      and(eq(invoices.id, invoiceId), sql`${invoices.viewedAt} is null`)
    );
}

/**
 * Mark an invoice as sent.
 */
export async function markInvoiceSent(invoiceId: string): Promise<void> {
  await db
    .update(invoices)
    .set({ sentAt: new Date(), status: "sent" })
    .where(eq(invoices.id, invoiceId));
}
