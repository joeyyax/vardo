import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, clients, invoices } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, sql, inArray } from "drizzle-orm";
import { startOfMonth, format } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

// GET /api/v1/organizations/[orgId]/clients/[clientId]/stats
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify client belongs to org
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");

    // Get this month's entries
    const monthEntries = await db
      .select({
        totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.clientId, clientId),
          eq(timeEntries.organizationId, orgId),
          gte(timeEntries.date, monthStart)
        )
      );

    // Get all time entries
    const allTimeEntries = await db
      .select({
        totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.clientId, clientId),
          eq(timeEntries.organizationId, orgId)
        )
      );

    // Get outstanding invoices (draft or sent)
    const outstandingInvoices = await db
      .select({
        count: sql<number>`COUNT(*)`,
        total: sql<number>`COALESCE(SUM(${invoices.subtotal}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, clientId),
          eq(invoices.organizationId, orgId),
          inArray(invoices.status, ["draft", "sent"])
        )
      );

    // Calculate billable amounts
    const rate = client.rateOverride ?? organization.defaultRate ?? 0;
    const totalMinutes = Number(monthEntries[0]?.totalMinutes || 0);
    const totalMinutesAllTime = Number(allTimeEntries[0]?.totalMinutes || 0);
    const totalBillable = Math.round((totalMinutes / 60) * rate);
    const totalBillableAllTime = Math.round((totalMinutesAllTime / 60) * rate);

    return NextResponse.json({
      totalMinutes,
      totalMinutesAllTime,
      totalBillable,
      totalBillableAllTime,
      outstandingInvoices: Number(outstandingInvoices[0]?.count || 0),
      pendingAmount: Number(outstandingInvoices[0]?.total || 0),
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
    console.error("Error fetching client stats:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
