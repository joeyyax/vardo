import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, clients, projects, tasks } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  startOfWeek,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  format,
} from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/analytics
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const period = url.searchParams.get("period") || "month";

    let fromDateStr: string;
    let toDateStr: string;

    // Use custom date range if both from and to are provided
    if (fromParam && toParam) {
      fromDateStr = fromParam;
      toDateStr = toParam;
    } else {
      // Fall back to period-based calculation
      const now = new Date();
      let fromDate: Date;

      switch (period) {
        case "week":
          fromDate = startOfWeek(now, { weekStartsOn: 1 }); // Monday
          break;
        case "month":
          fromDate = startOfMonth(now);
          break;
        case "quarter":
          fromDate = startOfQuarter(now);
          break;
        case "year":
          fromDate = startOfYear(now);
          break;
        default:
          fromDate = startOfMonth(now);
      }

      fromDateStr = format(fromDate, "yyyy-MM-dd");
      toDateStr = format(now, "yyyy-MM-dd");
    }

    // Query time entries with client, project, and task info for the period
    const entriesWithRelations = await db
      .select({
        durationMinutes: timeEntries.durationMinutes,
        date: timeEntries.date,
        clientId: timeEntries.clientId,
        clientName: clients.name,
        clientColor: clients.color,
        clientRate: clients.rateOverride,
        projectId: timeEntries.projectId,
        projectName: projects.name,
        isBillableOverride: timeEntries.isBillableOverride,
        clientIsBillable: clients.isBillable,
        projectIsBillable: projects.isBillable,
        projectRate: projects.rateOverride,
        taskIsBillable: tasks.isBillable,
        taskRate: tasks.rateOverride,
      })
      .from(timeEntries)
      .innerJoin(clients, eq(timeEntries.clientId, clients.id))
      .leftJoin(projects, eq(timeEntries.projectId, projects.id))
      .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
      .where(
        and(
          eq(timeEntries.organizationId, orgId),
          gte(timeEntries.date, fromDateStr),
          lte(timeEntries.date, toDateStr)
        )
      );

    if (entriesWithRelations.length === 0) {
      return NextResponse.json({
        totalMinutes: 0,
        totalBillable: 0,
        totalUnbillableMinutes: 0,
        uniqueClients: 0,
        averageHoursPerDay: 0,
        clientBreakdown: [],
        topProjects: [],
      });
    }

    // Helper to determine billability through inheritance chain:
    // entry override -> task -> project -> client -> default true
    const getIsBillable = (entry: (typeof entriesWithRelations)[0]): boolean => {
      if (entry.isBillableOverride !== null) return entry.isBillableOverride;
      if (entry.taskIsBillable !== null) return entry.taskIsBillable;
      if (entry.projectIsBillable !== null) return entry.projectIsBillable;
      if (entry.clientIsBillable !== null) return entry.clientIsBillable;
      return true;
    };

    // Helper to determine rate through inheritance chain:
    // task -> project -> client -> org default
    const getRate = (entry: (typeof entriesWithRelations)[0]): number => {
      return (
        entry.taskRate ??
        entry.projectRate ??
        entry.clientRate ??
        organization.defaultRate ??
        0
      );
    };

    // Calculate totals
    const totalMinutes = entriesWithRelations.reduce(
      (sum, entry) => sum + entry.durationMinutes,
      0
    );

    // Calculate billable and unbillable amounts
    let totalBillable = 0;
    let totalUnbillableMinutes = 0;

    for (const entry of entriesWithRelations) {
      const isBillable = getIsBillable(entry);
      if (!isBillable) {
        totalUnbillableMinutes += entry.durationMinutes;
        continue;
      }

      const rate = getRate(entry);
      const amount = Math.round((entry.durationMinutes / 60) * rate);
      totalBillable += amount;
    }

    // Group by client
    const clientMap = new Map<
      string,
      {
        name: string;
        color: string | null;
        totalMinutes: number;
        billableMinutes: number;
        unbillableMinutes: number;
        totalAmount: number;
      }
    >();

    for (const entry of entriesWithRelations) {
      const existing = clientMap.get(entry.clientId);
      const isBillable = getIsBillable(entry);
      const rate = getRate(entry);
      const amount = isBillable
        ? Math.round((entry.durationMinutes / 60) * rate)
        : 0;

      if (existing) {
        existing.totalMinutes += entry.durationMinutes;
        existing.totalAmount += amount;
        if (isBillable) {
          existing.billableMinutes += entry.durationMinutes;
        } else {
          existing.unbillableMinutes += entry.durationMinutes;
        }
      } else {
        clientMap.set(entry.clientId, {
          name: entry.clientName,
          color: entry.clientColor,
          totalMinutes: entry.durationMinutes,
          billableMinutes: isBillable ? entry.durationMinutes : 0,
          unbillableMinutes: isBillable ? 0 : entry.durationMinutes,
          totalAmount: amount,
        });
      }
    }

    const clientBreakdown = Array.from(clientMap.entries())
      .map(([id, data]) => ({
        id,
        ...data,
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes);

    // Group by project
    const projectMap = new Map<
      string,
      {
        name: string;
        clientName: string;
        totalMinutes: number;
        totalAmount: number;
      }
    >();

    for (const entry of entriesWithRelations) {
      if (!entry.projectId || !entry.projectName) continue;

      const existing = projectMap.get(entry.projectId);
      const isBillable = getIsBillable(entry);
      const rate = getRate(entry);
      const amount = isBillable
        ? Math.round((entry.durationMinutes / 60) * rate)
        : 0;

      if (existing) {
        existing.totalMinutes += entry.durationMinutes;
        existing.totalAmount += amount;
      } else {
        projectMap.set(entry.projectId, {
          name: entry.projectName,
          clientName: entry.clientName,
          totalMinutes: entry.durationMinutes,
          totalAmount: amount,
        });
      }
    }

    const topProjects = Array.from(projectMap.entries())
      .map(([id, data]) => ({
        id,
        ...data,
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes)
      .slice(0, 5);

    // Calculate average hours per day
    const uniqueDates = new Set(entriesWithRelations.map((e) => e.date));
    const daysWithEntries = uniqueDates.size;
    const averageHoursPerDay =
      daysWithEntries > 0 ? totalMinutes / 60 / daysWithEntries : 0;

    return NextResponse.json({
      totalMinutes,
      totalBillable,
      totalUnbillableMinutes,
      uniqueClients: clientMap.size,
      averageHoursPerDay,
      clientBreakdown,
      topProjects,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching analytics:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
