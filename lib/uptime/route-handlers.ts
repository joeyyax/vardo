// Monitor route handlers shared by the org and admin APIs. Each API supplies how a request becomes a scope.

import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import * as service from "./service";
import { UptimeInputError } from "./service";
import { createMonitorSchema, muteSchema, updateMonitorSchema, type Scope } from "./types";

type Params = Record<string, string>;
type Context = { params: Promise<Params> };

/** The scope when the caller may `view` or `manage` it, else null. May throw for admin auth. */
export type ResolveScope = (request: NextRequest, params: Params, access: "view" | "manage") => Promise<Scope | null>;

function inputError(error: unknown): NextResponse | null {
  return error instanceof UptimeInputError ? NextResponse.json({ error: error.message }, { status: 400 }) : null;
}

export function monitorCollectionRoutes(resolve: ResolveScope, key: string) {
  async function get(request: NextRequest, { params }: Context) {
    try {
      const scope = await resolve(request, await params, "view");
      if (!scope) return apiError.forbidden();
      return NextResponse.json({ monitors: await service.listMonitors(scope), vantages: await service.listVantages() });
    } catch (error) {
      return handleRouteError(error, "Error listing monitors");
    }
  }

  async function post(request: NextRequest, { params }: Context) {
    try {
      const scope = await resolve(request, await params, "manage");
      if (!scope) return apiError.forbidden();
      const parsed = createMonitorSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return apiError.validation(parsed.error);
      return NextResponse.json({ monitor: await service.createMonitor(scope, parsed.data) }, { status: 201 });
    } catch (error) {
      return inputError(error) ?? handleRouteError(error, "Error creating monitor");
    }
  }

  return {
    GET: withRateLimit(get, { tier: "read", key: `get:${key}` }),
    POST: withRateLimit(post, { tier: "mutation", key }),
  };
}

export function monitorItemRoutes(resolve: ResolveScope, key: string) {
  async function get(request: NextRequest, { params }: Context) {
    try {
      const p = await params;
      const scope = await resolve(request, p, "view");
      if (!scope) return apiError.forbidden();
      const monitor = await service.getMonitor(scope, p.monitorId);
      return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
    } catch (error) {
      return handleRouteError(error, "Error reading monitor");
    }
  }

  async function patch(request: NextRequest, { params }: Context) {
    try {
      const p = await params;
      const scope = await resolve(request, p, "manage");
      if (!scope) return apiError.forbidden();
      const parsed = updateMonitorSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return apiError.validation(parsed.error);
      const monitor = await service.updateMonitor(scope, p.monitorId, parsed.data);
      return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
    } catch (error) {
      return inputError(error) ?? handleRouteError(error, "Error updating monitor");
    }
  }

  async function del(request: NextRequest, { params }: Context) {
    try {
      const p = await params;
      const scope = await resolve(request, p, "manage");
      if (!scope) return apiError.forbidden();
      const result = await service.deleteMonitor(scope, p.monitorId);
      if (result === "missing") return apiError.notFound("monitor");
      if (result === "auto") return NextResponse.json({ error: "Automatic monitors can only be turned off." }, { status: 409 });
      return NextResponse.json({ success: true });
    } catch (error) {
      return handleRouteError(error, "Error deleting monitor");
    }
  }

  return {
    GET: withRateLimit(get, { tier: "read", key: `get:${key}` }),
    PATCH: withRateLimit(patch, { tier: "mutation", key }),
    DELETE: withRateLimit(del, { tier: "mutation", key }),
  };
}

export function monitorMuteRoutes(resolve: ResolveScope, key: string) {
  async function post(request: NextRequest, { params }: Context) {
    try {
      const p = await params;
      const scope = await resolve(request, p, "manage");
      if (!scope) return apiError.forbidden();
      const parsed = muteSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return apiError.validation(parsed.error);
      const monitor = await service.setMuted(scope, p.monitorId, parsed.data.muted);
      return monitor ? NextResponse.json({ monitor }) : apiError.notFound("monitor");
    } catch (error) {
      return handleRouteError(error, "Error muting monitor");
    }
  }
  return { POST: withRateLimit(post, { tier: "mutation", key }) };
}
