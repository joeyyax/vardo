import { db } from "@/lib/db";
import { reportConfigs, timeEntries, organizations } from "@/lib/db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { Resend } from "resend";
import { WeeklyReportEmail } from "@/lib/email/templates/weekly-report";
import {
  startOfWeek,
  endOfWeek,
  subWeeks,
  format,
  getDay,
  getHours,
} from "date-fns";

const resend = new Resend(process.env.RESEND_API_KEY);

type SendResult = {
  configId: string;
  clientName: string | null;
  projectName: string | null;
  success: boolean;
  error?: string;
  recipientCount?: number;
};

/**
 * Get report configs that should be sent now based on their auto_send_day and auto_send_hour.
 */
async function getReportsReadyToSend(): Promise<
  Array<{
    config: typeof reportConfigs.$inferSelect;
    organization: typeof organizations.$inferSelect;
    clientName: string | null;
    projectName: string | null;
  }>
> {
  const now = new Date();
  const currentDay = getDay(now); // 0-6, Sunday = 0
  const currentHour = getHours(now);

  // Find configs where autoSend is true and it's the right day/hour
  const configs = await db.query.reportConfigs.findMany({
    where: and(
      eq(reportConfigs.autoSend, true),
      eq(reportConfigs.enabled, true),
      eq(reportConfigs.autoSendDay, currentDay),
      eq(reportConfigs.autoSendHour, currentHour)
    ),
    with: {
      organization: true,
      client: true,
      project: true,
    },
  });

  return configs.map((config) => ({
    config,
    organization: config.organization,
    clientName: config.client?.name || null,
    projectName: config.project?.name || null,
  }));
}

/**
 * Build report data for a config.
 */
async function buildReportData(
  config: typeof reportConfigs.$inferSelect,
  organization: typeof organizations.$inferSelect
) {
  // Get previous week's data
  const now = new Date();
  const lastWeekStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
  const lastWeekEnd = endOfWeek(lastWeekStart, { weekStartsOn: 1 });

  const from = format(lastWeekStart, "yyyy-MM-dd");
  const to = format(lastWeekEnd, "yyyy-MM-dd");

  // Build query conditions
  const conditions = [
    eq(timeEntries.organizationId, config.organizationId),
    gte(timeEntries.date, from),
    lte(timeEntries.date, to),
  ];

  if (config.projectId) {
    conditions.push(eq(timeEntries.projectId, config.projectId));
  } else if (config.clientId) {
    conditions.push(eq(timeEntries.clientId, config.clientId));
  }

  // Fetch entries
  const entries = await db.query.timeEntries.findMany({
    where: and(...conditions),
    with: {
      client: true,
      project: true,
      task: true,
    },
    orderBy: [desc(timeEntries.date)],
  });

  // Calculate totals
  let totalMinutes = 0;
  let totalBillable = 0;
  const projectMinutes: Record<string, number> = {};

  for (const entry of entries) {
    totalMinutes += entry.durationMinutes;

    // Track by project
    const projectName = entry.project?.name || "No project";
    projectMinutes[projectName] = (projectMinutes[projectName] || 0) + entry.durationMinutes;

    // Calculate billable
    if (config.showRates) {
      const rate =
        entry.task?.rateOverride ??
        entry.project?.rateOverride ??
        entry.client?.rateOverride ??
        organization.defaultRate ??
        0;
      const isBillable =
        entry.isBillableOverride ??
        entry.task?.isBillable ??
        entry.project?.isBillable ??
        entry.client?.isBillable ??
        true;
      if (isBillable) {
        totalBillable += Math.round((entry.durationMinutes / 60) * rate);
      }
    }
  }

  // Build project breakdown
  const projectBreakdown = Object.entries(projectMinutes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5) // Top 5 projects
    .map(([name, minutes]) => ({
      name,
      minutes,
      percentage: totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 100) : 0,
    }));

  return {
    periodStart: from,
    periodEnd: to,
    totalMinutes,
    totalBillable,
    entryCount: entries.length,
    projectBreakdown,
  };
}

/**
 * Send a single report email.
 */
async function sendReport(
  config: typeof reportConfigs.$inferSelect,
  organization: typeof organizations.$inferSelect,
  clientName: string | null,
  projectName: string | null
): Promise<SendResult> {
  const recipients = (config.recipients as string[]) || [];

  if (recipients.length === 0) {
    return {
      configId: config.id,
      clientName,
      projectName,
      success: false,
      error: "No recipients configured",
    };
  }

  try {
    const reportData = await buildReportData(config, organization);
    const reportTitle = projectName || clientName || organization.name;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const reportUrl = `${baseUrl}/r/${config.slug}?from=${reportData.periodStart}&to=${reportData.periodEnd}`;

    // Send to each recipient
    for (const recipient of recipients) {
      await resend.emails.send({
        from: `${organization.name} <reports@${process.env.RESEND_DOMAIN || "resend.dev"}>`,
        to: recipient,
        subject: `Weekly Time Report: ${reportTitle}`,
        react: WeeklyReportEmail({
          organizationName: organization.name,
          reportTitle,
          periodStart: reportData.periodStart,
          periodEnd: reportData.periodEnd,
          totalMinutes: reportData.totalMinutes,
          totalBillable: config.showRates ? reportData.totalBillable : undefined,
          entryCount: reportData.entryCount,
          projectBreakdown: reportData.projectBreakdown,
          reportUrl,
          showRates: config.showRates ?? false,
        }),
      });
    }

    return {
      configId: config.id,
      clientName,
      projectName,
      success: true,
      recipientCount: recipients.length,
    };
  } catch (error) {
    return {
      configId: config.id,
      clientName,
      projectName,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Main function to run auto report sending.
 */
export async function runAutoReportSending(): Promise<{
  processed: number;
  successful: number;
  failed: number;
  results: SendResult[];
}> {
  const reportsToSend = await getReportsReadyToSend();
  const results: SendResult[] = [];

  for (const { config, organization, clientName, projectName } of reportsToSend) {
    const result = await sendReport(config, organization, clientName, projectName);
    results.push(result);
  }

  return {
    processed: results.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}
