import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { format } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/entries/export?from=&to=&format=csv
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");

    // Build query conditions
    const conditions = [eq(timeEntries.organizationId, orgId)];

    if (from) {
      conditions.push(gte(timeEntries.date, from));
    }
    if (to) {
      conditions.push(lte(timeEntries.date, to));
    }
    if (clientId) {
      conditions.push(eq(timeEntries.clientId, clientId));
    }
    if (projectId) {
      conditions.push(eq(timeEntries.projectId, projectId));
    }

    // Fetch entries with relations
    const entries = await db.query.timeEntries.findMany({
      where: and(...conditions),
      with: {
        client: true,
        project: true,
        task: true,
        user: true,
      },
      orderBy: [desc(timeEntries.date)],
    });

    // Build CSV
    const headers = [
      "Date",
      "Client",
      "Project",
      "Task",
      "Description",
      "Hours",
      "Minutes",
      "Billable",
      "Rate (cents/hr)",
      "Amount (cents)",
      "User",
    ];

    const rows = entries.map((entry) => {
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
      const amount = isBillable ? Math.round((entry.durationMinutes / 60) * rate) : 0;

      return [
        entry.date,
        entry.client?.name || "",
        entry.project?.name || "",
        entry.task?.name || "",
        (entry.description || "").replace(/"/g, '""'), // Escape quotes
        (entry.durationMinutes / 60).toFixed(2),
        entry.durationMinutes.toString(),
        isBillable ? "Yes" : "No",
        rate.toString(),
        amount.toString(),
        entry.user?.name || entry.user?.email || "",
      ];
    });

    // Format as CSV
    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row
          .map((cell) => {
            // Quote fields that contain commas, quotes, or newlines
            if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
              return `"${cell}"`;
            }
            return cell;
          })
          .join(",")
      ),
    ].join("\n");

    // Generate filename
    const dateRange = from && to ? `${from}_to_${to}` : format(new Date(), "yyyy-MM-dd");
    const filename = `time-entries-${dateRange}.csv`;

    return new NextResponse(csvContent, {
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
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error exporting entries:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
