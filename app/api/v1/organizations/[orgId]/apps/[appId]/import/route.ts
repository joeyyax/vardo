import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { z } from "zod";
import { apiError, describeIssue, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { csrfRejection } from "@/lib/security/csrf";
import { ImportError, importIntoApp, importMaxBytes, type ImportSource } from "@/lib/backups/import";

// Excluded from proxy.ts, which caps request bodies at the proxy body limit. CSRF is checked here instead.

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const targetSchema = z.object({
  volume: z.string().min(1).max(128),
  database: z.string().min(1).max(64).optional(),
});

const fetchSchema = targetSchema.extend({
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("url"), url: z.string().url() }),
    z.object({
      type: z.literal("ssh"),
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().min(1).max(64),
      path: z.string().min(1).max(4096),
      privateKey: z.string().max(16_384).optional(),
    }),
  ]),
}).strict();

type Access = { orgId: string; appId: string; userId: string; trusted: boolean };

async function authorize(request: NextRequest, params: RouteParams["params"]): Promise<Access | Response> {
  const csrf = csrfRejection({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
  });
  if (csrf) return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });

  const gate = await requirePlugin("backups");
  if (gate) return gate;

  const { orgId, appId } = await params;
  const org = await verifyOrgAccess(orgId, "backup.restore");
  if (!org) return apiError.forbidden();
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { isSystemManaged: true },
  });
  if (!app) return apiError.notFound("app");
  if (app.isSystemManaged) return apiError.forbidden();

  return { orgId, appId, userId: org.session.user.id, trusted: org.organization.trusted };
}

async function run(access: Access, target: z.infer<typeof targetSchema>, source: ImportSource) {
  recordActivity({
    organizationId: access.orgId,
    action: "backup.import_started",
    appId: access.appId,
    userId: access.userId,
    metadata: { volumeName: target.volume, source: source.type },
  }).catch(() => {});

  try {
    const result = await importIntoApp({
      appId: access.appId,
      organizationId: access.orgId,
      volumeName: target.volume,
      database: target.database,
      source,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

// PUT /api/v1/organizations/[orgId]/apps/[appId]/import?volume=<name>[&database=<name>]
// The body is the file: a pg_dump (custom or plain), a SQL dump, or a tar/tar.gz of the volume.
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const access = await authorize(request, params);
    if (access instanceof Response) return access;

    const parsed = targetSchema.safeParse({
      volume: request.nextUrl.searchParams.get("volume") ?? undefined,
      database: request.nextUrl.searchParams.get("database") ?? undefined,
    });
    if (!parsed.success) return NextResponse.json({ error: describeIssue(parsed.error.issues[0]) }, { status: 400 });

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > importMaxBytes()) {
      return NextResponse.json({ error: "The file is larger than the import limit" }, { status: 413 });
    }
    if (!request.body) return NextResponse.json({ error: "Send the file as the request body" }, { status: 400 });

    const stream = Readable.fromWeb(request.body as unknown as NodeReadableStream);
    return await run(access, parsed.data, { type: "upload", stream });
  } catch (error) {
    return handleRouteError(error, "Error importing data");
  }
}

// POST /api/v1/organizations/[orgId]/apps/[appId]/import
// { volume, database?, source: { type: "url", url } | { type: "ssh", host, port?, username, path, privateKey? } }
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const access = await authorize(request, params);
    if (access instanceof Response) return access;

    const body = await request.json().catch(() => null);
    const parsed = fetchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: describeIssue(parsed.error.issues[0]) }, { status: 400 });

    // The host makes the request, so it can reach what the org can't.
    if (!access.trusted) {
      return NextResponse.json(
        { error: "Fetching from a URL or SSH needs a trusted organization. Upload the file instead." },
        { status: 403 },
      );
    }

    const { source, ...target } = parsed.data;
    return await run(access, target, source);
  } catch (error) {
    return handleRouteError(error, "Error importing data");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "critical", key: "app-import" });
export const POST = withRateLimit(handlePost, { tier: "critical", key: "app-import" });
