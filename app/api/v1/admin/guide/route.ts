import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { GUIDE_STEPS, getCompletedSteps } from "@/lib/setup/guide";

// GET /api/v1/admin/guide — returns guide steps with completion status
export async function GET() {
  try {
    await requireAppAdmin();

    const completed = await getCompletedSteps();
    const completedIds = Array.from(completed);

    return NextResponse.json({
      steps: GUIDE_STEPS,
      completed: completedIds,
      total: GUIDE_STEPS.length,
      done: completedIds.length,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handleRouteError(error, "Error fetching guide progress");
  }
}
