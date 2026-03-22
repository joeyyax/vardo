import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { templates } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { asc } from "drizzle-orm";

// GET /api/v1/templates
export async function GET(_request: NextRequest) {
  try {
    await requireSession();

    const templateList = await db.query.templates.findMany({
      orderBy: [asc(templates.category), asc(templates.displayName)],
    });

    return NextResponse.json({ templates: templateList });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
