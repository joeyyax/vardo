import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/error-response";
import type { BanOutcome } from "./bans";

/** The API answer to "Ban again". */
export function banAgainResponse(outcome: BanOutcome | null): NextResponse {
  if (!outcome) return apiError.notFound("ban");
  if (outcome.status === "refused") return NextResponse.json({ error: `Can't ban this address: ${outcome.reason}.` }, { status: 409 });
  return NextResponse.json({ ok: true, already: outcome.status === "already" });
}
