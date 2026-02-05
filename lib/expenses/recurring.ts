import { db } from "@/lib/db";
import { projectExpenses } from "@/lib/db/schema";
import { eq, and, lte, isNull, isNotNull, or } from "drizzle-orm";
import { addWeeks, addMonths, addYears, format } from "date-fns";

/**
 * Calculate the next occurrence date based on frequency
 */
function calculateNextOccurrence(currentDate: string, frequency: string): string {
  const d = new Date(currentDate);
  switch (frequency) {
    case "weekly":
      return format(addWeeks(d, 1), "yyyy-MM-dd");
    case "monthly":
      return format(addMonths(d, 1), "yyyy-MM-dd");
    case "quarterly":
      return format(addMonths(d, 3), "yyyy-MM-dd");
    case "yearly":
      return format(addYears(d, 1), "yyyy-MM-dd");
    default:
      return format(addMonths(d, 1), "yyyy-MM-dd");
  }
}

/**
 * Process all recurring expenses that are due
 * Returns the number of expenses generated
 */
export async function processRecurringExpenses(): Promise<{
  processed: number;
  generated: number;
  errors: string[];
}> {
  const today = format(new Date(), "yyyy-MM-dd");
  const errors: string[] = [];
  let generated = 0;

  // Find all recurring expense templates where:
  // - isRecurring = true
  // - nextOccurrence <= today
  // - (recurringEndDate is null OR recurringEndDate >= today)
  // - parentExpenseId is null (these are templates, not generated expenses)
  const dueExpenses = await db.query.projectExpenses.findMany({
    where: and(
      eq(projectExpenses.isRecurring, true),
      isNotNull(projectExpenses.nextOccurrence),
      lte(projectExpenses.nextOccurrence, today),
      isNull(projectExpenses.parentExpenseId),
      or(
        isNull(projectExpenses.recurringEndDate),
        // Can't use gte directly with date strings, so we handle this in code
      )
    ),
  });

  // Filter out any that have passed their end date
  const activeExpenses = dueExpenses.filter((expense) => {
    if (!expense.recurringEndDate) return true;
    return expense.recurringEndDate >= today;
  });

  for (const template of activeExpenses) {
    try {
      // Create the new expense entry
      const [newExpense] = await db
        .insert(projectExpenses)
        .values({
          organizationId: template.organizationId,
          projectId: template.projectId,
          description: template.description,
          amountCents: template.amountCents,
          date: template.nextOccurrence!, // Use the scheduled date
          category: template.category,
          isBillable: template.isBillable,
          receiptFileId: null, // Generated expenses don't have receipts
          source: "recurring",
          isRecurring: false, // The generated expense is not a template
          parentExpenseId: template.id, // Link to template
          createdBy: template.createdBy,
        })
        .returning();

      if (newExpense) {
        generated++;

        // Calculate and update the next occurrence on the template
        const nextDate = calculateNextOccurrence(
          template.nextOccurrence!,
          template.recurringFrequency!
        );

        // Check if next date is past the end date
        const shouldContinue = !template.recurringEndDate || nextDate <= template.recurringEndDate;

        await db
          .update(projectExpenses)
          .set({
            nextOccurrence: shouldContinue ? nextDate : null,
            updatedAt: new Date(),
          })
          .where(eq(projectExpenses.id, template.id));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Failed to process expense ${template.id}: ${message}`);
    }
  }

  return {
    processed: activeExpenses.length,
    generated,
    errors,
  };
}

/**
 * Get all recurring expense templates for an organization
 */
export async function getRecurringTemplates(orgId: string) {
  return db.query.projectExpenses.findMany({
    where: and(
      eq(projectExpenses.organizationId, orgId),
      eq(projectExpenses.isRecurring, true),
      isNull(projectExpenses.parentExpenseId)
    ),
    with: {
      project: {
        columns: { id: true, name: true },
        with: {
          client: {
            columns: { id: true, name: true, color: true },
          },
        },
      },
    },
    orderBy: (expenses, { asc }) => [asc(expenses.nextOccurrence)],
  });
}
