import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, EXPENSE_STATUSES, type ExpenseStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, isNull } from "drizzle-orm";
import { format } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const clientId = searchParams.get("clientId");
    const category = searchParams.get("category");
    const vendor = searchParams.get("vendor");
    const status = searchParams.get("status");
    const billableOnly = searchParams.get("billable") === "true";
    const overheadOnly = searchParams.get("overhead") === "true";

    // Build where conditions
    const whereConditions = [eq(projectExpenses.organizationId, orgId)];

    if (startDate) {
      whereConditions.push(gte(projectExpenses.date, startDate));
    }
    if (endDate) {
      whereConditions.push(lte(projectExpenses.date, endDate));
    }
    if (category) {
      whereConditions.push(eq(projectExpenses.category, category));
    }
    if (vendor) {
      whereConditions.push(eq(projectExpenses.vendor, vendor));
    }
    if (status && EXPENSE_STATUSES.includes(status as ExpenseStatus)) {
      whereConditions.push(eq(projectExpenses.status, status as ExpenseStatus));
    }
    if (billableOnly) {
      whereConditions.push(eq(projectExpenses.isBillable, true));
    }
    if (overheadOnly) {
      whereConditions.push(isNull(projectExpenses.projectId));
    }

    const expenses = await db.query.projectExpenses.findMany({
      where: and(...whereConditions),
      orderBy: (exp, { desc }) => [desc(exp.date)],
      with: {
        project: {
          columns: { id: true, name: true },
          with: {
            client: { columns: { id: true, name: true } },
          },
        },
      },
    });

    // Filter by clientId post-query if needed
    let filteredExpenses = expenses;
    if (clientId) {
      filteredExpenses = expenses.filter(
        (e) => e.project?.client?.id === clientId
      );
    }

    // Generate CSV
    const headers = [
      "Date",
      "Description",
      "Amount",
      "Category",
      "Vendor",
      "Client",
      "Project",
      "Billable",
      "Status",
      "Paid Date",
    ];

    const rows = filteredExpenses.map((e) => [
      e.date,
      `"${(e.description || "").replace(/"/g, '""')}"`,
      (e.amountCents / 100).toFixed(2),
      e.category || "",
      e.vendor || "",
      e.project?.client?.name || "Overhead",
      e.project?.name || "",
      e.isBillable ? "Yes" : "No",
      e.status || "paid",
      e.paidAt || "",
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    const filename = `expenses-${format(new Date(), "yyyy-MM-dd")}.csv`;

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error exporting expenses:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
