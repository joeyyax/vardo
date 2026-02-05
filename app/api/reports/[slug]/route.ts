import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reportConfigs, timeEntries } from "@/lib/db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { startOfWeek, endOfWeek, format } from "date-fns";

type RouteParams = {
  params: Promise<{ slug: string }>;
};

// GET /api/reports/[slug] - Public report data (no auth required)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(request.url);

    // Get date range from query params (default to current week)
    const now = new Date();
    const defaultFrom = format(startOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const defaultTo = format(endOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const from = searchParams.get("from") || defaultFrom;
    const to = searchParams.get("to") || defaultTo;

    // Find report config by slug
    const config = await db.query.reportConfigs.findFirst({
      where: eq(reportConfigs.slug, slug),
      with: {
        organization: true,
        client: true,
        project: true,
      },
    });

    if (!config) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    if (!config.enabled) {
      return NextResponse.json({ error: "Report is disabled" }, { status: 403 });
    }

    // Build query conditions
    const conditions = [
      eq(timeEntries.organizationId, config.organizationId),
      gte(timeEntries.date, from),
      lte(timeEntries.date, to),
    ];

    // Filter by client or project if specified in config
    if (config.projectId) {
      conditions.push(eq(timeEntries.projectId, config.projectId));
    } else if (config.clientId) {
      conditions.push(eq(timeEntries.clientId, config.clientId));
    }

    // Fetch entries with related data
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

    // Group entries by date
    const entriesByDate: Record<string, typeof entries> = {};

    for (const entry of entries) {
      totalMinutes += entry.durationMinutes;

      // Calculate billable if showing rates
      if (config.showRates) {
        const rate =
          entry.task?.rateOverride ??
          entry.project?.rateOverride ??
          entry.client?.rateOverride ??
          config.organization.defaultRate ??
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

      // Group by date
      if (!entriesByDate[entry.date]) {
        entriesByDate[entry.date] = [];
      }
      entriesByDate[entry.date].push(entry);
    }

    // Format entries for response
    const formattedEntries = entries.map((entry) => ({
      id: entry.id,
      date: entry.date,
      description: entry.description,
      minutes: entry.durationMinutes,
      client: entry.client?.name || "Unknown",
      project: entry.project?.name || null,
      task: entry.task?.name || null,
      ...(config.showRates && {
        rate:
          entry.task?.rateOverride ??
          entry.project?.rateOverride ??
          entry.client?.rateOverride ??
          config.organization.defaultRate ??
          0,
        isBillable:
          entry.isBillableOverride ??
          entry.task?.isBillable ??
          entry.project?.isBillable ??
          entry.client?.isBillable ??
          true,
      }),
    }));

    // Group entries by date for the response
    const groupedByDate = Object.entries(entriesByDate)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, dateEntries]) => ({
        date,
        entries: dateEntries.map((entry) => ({
          id: entry.id,
          description: entry.description,
          minutes: entry.durationMinutes,
          project: entry.project?.name || null,
          task: entry.task?.name || null,
          ...(config.showRates && {
            amount: Math.round(
              (entry.durationMinutes / 60) *
                (entry.task?.rateOverride ??
                  entry.project?.rateOverride ??
                  entry.client?.rateOverride ??
                  config.organization.defaultRate ??
                  0)
            ),
          }),
        })),
        totalMinutes: dateEntries.reduce((sum, e) => sum + e.durationMinutes, 0),
      }));

    return NextResponse.json({
      report: {
        title: config.project?.name || config.client?.name || config.organization.name,
        subtitle: config.project ? config.client?.name : null,
        organizationName: config.organization.name,
        showRates: config.showRates,
        periodStart: from,
        periodEnd: to,
      },
      summary: {
        totalMinutes,
        totalHours: (totalMinutes / 60).toFixed(1),
        ...(config.showRates && { totalBillable }),
        entryCount: entries.length,
      },
      entriesByDate: groupedByDate,
      entries: formattedEntries,
    });
  } catch (error) {
    console.error("Error fetching public report:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
