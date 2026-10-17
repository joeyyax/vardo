// Monitor responses shared by the org and admin APIs. The routes check access, then hand a scope here.

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/error-response";
import * as service from "./service";
import { UptimeInputError } from "./service";
import { answerReview, detectForUrl } from "./health";
import { createMonitorSchema, detectSchema, muteSchema, reviewAnswerSchema, updateMonitorSchema, type Scope, type UptimeRange } from "./types";

/** Runs a write, answering a rejected input with a 400. */
async function guarded(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UptimeInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

const body = (request: NextRequest) => request.json().catch(() => null);

export const monitorResponses = {
  async list(scope: Scope, range?: UptimeRange) {
    return NextResponse.json({ monitors: await service.listMonitors(scope, Date.now(), range), vantages: await service.listVantages() });
  },

  create(scope: Scope, request: NextRequest) {
    return guarded(async () => {
      const parsed = createMonitorSchema.safeParse(await body(request));
      if (!parsed.success) return apiError.validation(parsed.error);
      return NextResponse.json({ monitor: await service.createMonitor(scope, parsed.data) }, { status: 201 });
    });
  },

  async get(scope: Scope, monitorId: string, range?: UptimeRange) {
    const monitor = await service.getMonitor(scope, monitorId, Date.now(), range);
    return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
  },

  update(scope: Scope, monitorId: string, request: NextRequest) {
    return guarded(async () => {
      const parsed = updateMonitorSchema.safeParse(await body(request));
      if (!parsed.success) return apiError.validation(parsed.error);
      const monitor = await service.updateMonitor(scope, monitorId, parsed.data);
      return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
    });
  },

  async remove(scope: Scope, monitorId: string) {
    const result = await service.deleteMonitor(scope, monitorId);
    if (result === "missing") return apiError.notFound("monitor");
    if (result === "auto") return NextResponse.json({ error: "Automatic monitors can only be turned off." }, { status: 409 });
    return NextResponse.json({ success: true });
  },

  async mute(scope: Scope, monitorId: string, request: NextRequest) {
    const parsed = muteSchema.safeParse(await body(request));
    if (!parsed.success) return apiError.validation(parsed.error);
    const monitor = await service.setMuted(scope, monitorId, parsed.data.muted);
    return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
  },

  detect(scope: Scope, request: NextRequest) {
    return guarded(async () => {
      const parsed = detectSchema.safeParse(await body(request));
      if (!parsed.success) return apiError.validation(parsed.error);
      const headers = parsed.data.headers && Object.fromEntries(parsed.data.headers.map((h) => [h.name, h.value]));
      return NextResponse.json({ detected: await detectForUrl(scope, parsed.data.url, headers) });
    });
  },

  review(scope: Scope, monitorId: string, request: NextRequest) {
    return guarded(async () => {
      const parsed = reviewAnswerSchema.safeParse(await body(request));
      if (!parsed.success) return apiError.validation(parsed.error);
      if (!(await answerReview(scope, monitorId, parsed.data))) return apiError.notFound("monitor");
      const monitor = await service.getMonitor(scope, monitorId);
      return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
    });
  },
};
