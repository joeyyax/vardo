import { NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { securityOverview } from "@/lib/security/overview";
import { guardOverview } from "@/lib/probe-guard/overview";

// GET /api/v1/admin/overview/security — findings across apps plus the probe guard's counts.
async function handleGet() {
  try {
    await requireAppAdmin();
    const [findings, guard] = await Promise.all([securityOverview(), guardOverview()]);
    const total = guard.bans.length;
    const local = guard.bans.filter((b) => b.reason !== "blocklist" && b.reason !== "mesh").length;
    const blocklist = guard.bans.filter((b) => b.reason === "blocklist").length;
    const shared = guard.bans.filter((b) => b.reason === "mesh").length;
    const bansBreakdown = total === 0 ? "none active" : `${local} local · ${blocklist} blocklist · ${shared} shared`;
    return NextResponse.json({
      ...findings,
      bans: total,
      bansBreakdown,
      probes: guard.stats.probes,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching security overview");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/overview/security" });