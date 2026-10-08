import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { describeKeyEscrow, reconcileKeyFingerprint } from "@/lib/crypto/key-escrow";

// GET /api/v1/system/encryption-key — fingerprint and escrow state of the
// master key. Never the key itself.
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const state = await reconcileKeyFingerprint();
    const { severity, headline } = describeKeyEscrow(state);

    return NextResponse.json({
      severity,
      headline,
      status: state.status.kind,
      fingerprint: "running" in state.status
        ? state.status.running
        : "fingerprint" in state.status
          ? state.status.fingerprint
          : null,
      recorded: "recorded" in state.status ? state.status.recorded : null,
      encrypted: state.probe.encrypted,
      undecryptable: state.probe.undecryptable,
      samples: state.probe.samples,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiError.unauthorized();
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error reading encryption key state");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/system/encryption-key" });
