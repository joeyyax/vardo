import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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

    const { stdout } = await execAsync(
      "docker system prune -f --volumes 2>&1 | tail -1",
      { timeout: 60000 }
    );

    const spaceReclaimed = stdout.trim();

    return NextResponse.json({ success: true, spaceReclaimed });
  } catch (error) {
    return handleRouteError(error);
  }
}
