import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { seedTemplates } from "@/lib/db/seed-templates";
import { eq } from "drizzle-orm";

// POST /api/v1/templates/seed
export async function POST(_request: NextRequest) {
  try {
    const session = await requireSession();

    const dbUser = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
      columns: { isAppAdmin: true },
    });

    if (!dbUser?.isAppAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await seedTemplates();

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error seeding templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
