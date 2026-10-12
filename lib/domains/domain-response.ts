// HTTP shape for a domain write's outcome, shared by the app domain routes.

import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/error-response";
import type { DomainResult } from "./manage";

export function domainResponse(result: DomainResult, status = 200): NextResponse {
  if (result.ok) {
    const body = result.kind === "removed" ? { success: true } : { domain: result.domain };
    return NextResponse.json(body, { status });
  }
  if (result.status === 404) return apiError.notFound(result.error);
  return NextResponse.json(
    { error: result.error, ...(result.claimable ? { claimable: true } : {}) },
    { status: result.status },
  );
}
