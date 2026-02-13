import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invoices, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type ActivityEvent = {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  event: "paid" | "sent" | "viewed";
  amount: number;
  date: string;
};

// GET /api/v1/organizations/[orgId]/reports/invoices
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { orgId } = await params;

  let organization;
  let membership;
  try {
    const result = await requireOrg();
    organization = result.organization;
    membership = result.membership;
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
    throw error;
  }

  if (organization.id !== orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    requireAdmin(membership.role);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get("clientId");

  // Build where conditions
  const whereConditions = [eq(invoices.organizationId, orgId)];
  if (clientId) {
    whereConditions.push(eq(invoices.clientId, clientId));
  }

  // Fetch all invoices with client info
  const invoiceList = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      subtotal: invoices.subtotal,
      dueDate: invoices.dueDate,
      sentAt: invoices.sentAt,
      viewedAt: invoices.viewedAt,
      clientName: clients.name,
    })
    .from(invoices)
    .innerJoin(clients, eq(invoices.clientId, clients.id))
    .where(and(...whereConditions));

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  // Calculate totals by status
  let paid = 0;
  let pending = 0;
  let overdue = 0;
  let draft = 0;

  // Aging breakdown (for status "sent" only)
  let agingCurrent = 0;
  let aging1to30 = 0;
  let aging31to60 = 0;
  let aging60plus = 0;

  // Collect events for recent activity
  const events: ActivityEvent[] = [];

  for (const inv of invoiceList) {
    const subtotal = inv.subtotal ?? 0;

    // Categorize by status
    if (inv.status === "paid") {
      paid += subtotal;

      // Add paid event if we have viewedAt (using as proxy for paid date)
      // Since there's no explicit paidAt, we use viewedAt or sentAt
      if (inv.viewedAt) {
        events.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          clientName: inv.clientName,
          event: "paid",
          amount: subtotal,
          date: inv.viewedAt.toISOString(),
        });
      }
    } else if (inv.status === "draft") {
      draft += subtotal;
    } else if (inv.status === "sent" || inv.status === "viewed") {
      // For sent/viewed: check if overdue or pending
      const isOverdue = inv.dueDate && inv.dueDate < todayStr;

      if (isOverdue) {
        overdue += subtotal;

        // Calculate days past due for aging
        const dueDate = new Date(inv.dueDate!);
        const daysPastDue = Math.floor(
          (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysPastDue <= 30) {
          aging1to30 += subtotal;
        } else if (daysPastDue <= 60) {
          aging31to60 += subtotal;
        } else {
          aging60plus += subtotal;
        }
      } else {
        pending += subtotal;
        agingCurrent += subtotal;
      }
    }

    // Add sent event
    if (inv.sentAt) {
      events.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientName: inv.clientName,
        event: "sent",
        amount: subtotal,
        date: inv.sentAt.toISOString(),
      });
    }

    // Add viewed event (only if different from paid event date)
    if (inv.viewedAt && inv.status !== "paid") {
      events.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientName: inv.clientName,
        event: "viewed",
        amount: subtotal,
        date: inv.viewedAt.toISOString(),
      });
    }
  }

  // Sort events by date descending and take top 10
  const recentActivity = events
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10);

  return NextResponse.json({
    paid,
    pending,
    overdue,
    draft,
    aging: {
      current: agingCurrent,
      days1to30: aging1to30,
      days31to60: aging31to60,
      days60plus: aging60plus,
    },
    recentActivity,
  });
}
