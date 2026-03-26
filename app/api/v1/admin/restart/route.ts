import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { hostname } from "os";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";

// POST /api/v1/admin/restart
export async function POST() {
  try {
    await requireAppAdmin();

    const containerId = hostname();

    setTimeout(() => {
      spawn("docker", ["restart", containerId], { detached: true, stdio: "ignore" }).unref();
    }, 2000);

    return NextResponse.json({ success: true, message: "Restarting in 2 seconds..." });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error);
  }
}
