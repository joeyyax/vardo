import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte } from "drizzle-orm";
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
    const period = url.searchParams.get("period") || "month";

    // Calculate date range based on period
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

    const fromDateStr = format(fromDate, "yyyy-MM-dd");

    // Query time entries with client info for the period
    const entriesWithClients = await db
      .select({
        durationMinutes: timeEntries.durationMinutes,
        date: timeEntries.date,
        clientId: timeEntries.clientId,
        clientName: clients.name,
        clientColor: clients.color,
        clientRate: clients.rateOverride,
        isBillableOverride: timeEntries.isBillableOverride,
        clientIsBillable: clients.isBillable,
      })
      .from(timeEntries)
      .innerJoin(clients, eq(timeEntries.clientId, clients.id))
      .where(
        and(
          eq(timeEntries.organizationId, orgId),
          gte(timeEntries.date, fromDateStr)
        )
      );

    if (entriesWithClients.length === 0) {
      return NextResponse.json({
        totalMinutes: 0,
        totalBillable: 0,
        uniqueClients: 0,
        averageHoursPerDay: 0,
        clientBreakdown: [],
      });
    }

    // Calculate totals
    const totalMinutes = entriesWithClients.reduce(
      (sum, entry) => sum + entry.durationMinutes,
      0
    );

    // Calculate billable amount
    const orgDefaultRate = organization.defaultRate || 0;
    let totalBillable = 0;

    for (const entry of entriesWithClients) {
      // Determine if billable
      const isBillable =
        entry.isBillableOverride ?? entry.clientIsBillable ?? true;
      if (!isBillable) continue;

      // Determine rate (client override or org default)
      const rate = entry.clientRate ?? orgDefaultRate;

      // Calculate amount: (minutes / 60) * rate
      const amount = Math.round((entry.durationMinutes / 60) * rate);
      totalBillable += amount;
    }

    // Group by client
    const clientMap = new Map<
      string,
      { name: string; color: string | null; totalMinutes: number; totalAmount: number }
    >();

    for (const entry of entriesWithClients) {
      const existing = clientMap.get(entry.clientId);
      const rate = entry.clientRate ?? orgDefaultRate;
      const isBillable =
        entry.isBillableOverride ?? entry.clientIsBillable ?? true;
      const amount = isBillable
        ? Math.round((entry.durationMinutes / 60) * rate)
        : 0;

      if (existing) {
        existing.totalMinutes += entry.durationMinutes;
        existing.totalAmount += amount;
      } else {
        clientMap.set(entry.clientId, {
          name: entry.clientName,
          color: entry.clientColor,
          totalMinutes: entry.durationMinutes,
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

    // Calculate average hours per day
    const uniqueDates = new Set(entriesWithClients.map((e) => e.date));
    const daysWithEntries = uniqueDates.size;
    const averageHoursPerDay =
      daysWithEntries > 0 ? totalMinutes / 60 / daysWithEntries : 0;

    return NextResponse.json({
      totalMinutes,
      totalBillable,
      uniqueClients: clientMap.size,
      averageHoursPerDay,
      clientBreakdown,
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
