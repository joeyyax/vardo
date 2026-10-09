import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { CERT_RESOLVERS, getSslConfig, getDefaultCertResolver } from "@/lib/system-settings";
import { apps, organizations } from "@/lib/db/schema";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { HOSTNAME_RE } from "@/lib/security/hostname";
import { proofForNewDomain } from "@/lib/domains/context";
import { hostHoldByOtherOrg, withClaim, type Claim } from "@/lib/domains/claim";
import { normalizePathPrefix } from "@/lib/domains/path-prefix";
import { middlewareProblem, serializeMiddlewares } from "@/lib/domains/middlewares";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};


// "/docs"; empty or "/" routes the whole host.
const pathPrefixSchema = z
  .string()
  .nullable()
  .transform((v, ctx) => {
    const normalized = normalizePathPrefix(v);
    if (normalized === undefined) {
      ctx.addIssue({ code: "custom", message: "Path must look like /docs, using letters, digits and . _ ~ -" });
      return z.NEVER;
    }
    return normalized;
  });

const HOST_TAKEN = "Another organization already routes that domain.";
const HOST_CLAIMABLE = "Another organization added it but hasn't verified it. Verify it under Settings → Domains to claim it.";

// Traefik middleware references, e.g. "cloudflare-only@file".
const middlewaresSchema = z.array(z.string().trim().min(1).max(100)).max(10).nullable();

/** The stored value, or why the organization can't use one of the middlewares. */
async function checkMiddlewares(list: string[] | null, orgId: string): Promise<{ value: string | null } | { error: string }> {
  if (!list || list.length === 0) return { value: null };
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { trusted: true },
  });
  for (const ref of list) {
    const problem = middlewareProblem(ref, org?.trusted ?? false);
    if (problem) return { error: problem };
  }
  return { value: serializeMiddlewares(list) };
}

const createDomainSchema = z.object({
  domain: z.string().min(1, "Domain is required").regex(HOSTNAME_RE, "Invalid domain name"),
  serviceName: z.string().optional(),
  port: z.number().int().positive().optional(),
  certResolver: z.enum(CERT_RESOLVERS).optional(),
  redirectTo: z.string().url("Must be a valid URL").optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
  pathPrefix: pathPrefixSchema.optional(),
  stripPathPrefix: z.boolean().optional(),
  middlewares: middlewaresSchema.optional(),
}).strict();

const deleteDomainSchema = z.object({
  id: z.string().min(1),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "domains");
    if (refused) return refused;

    const body = await request.json();
    const parsed = createDomainSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    // Redirect domains can't self-reference.
    if (parsed.data.redirectTo) {
      try {
        const targetHost = new URL(parsed.data.redirectTo).hostname;
        if (targetHost === parsed.data.domain) {
          return NextResponse.json(
            { error: "Redirect target can't be the same domain (infinite redirect loop)" },
            { status: 400 }
          );
        }
      } catch {
        // URL parsing handled by zod
      }
    }

    const domainName = parsed.data.domain.toLowerCase();
    const proof = await proofForNewDomain(domainName, orgId);
    if ("refusal" in proof) {
      return NextResponse.json({ error: `Couldn't add domain. ${proof.refusal}` }, { status: 400 });
    }
    const hold = await hostHoldByOtherOrg(domainName, orgId);
    if (hold === "taken") {
      return NextResponse.json({ error: `Couldn't add domain. ${HOST_TAKEN}` }, { status: 409 });
    }
    // Unverified rows elsewhere yield only to a host this org proved through a verified zone.
    if (hold === "claimable" && !proof.verifiedAt) {
      return NextResponse.json({ error: `Couldn't add domain. ${HOST_CLAIMABLE}`, claimable: true }, { status: 409 });
    }
    const middlewares = await checkMiddlewares(parsed.data.middlewares ?? null, orgId);
    if ("error" in middlewares) {
      return NextResponse.json({ error: `Couldn't add domain. ${middlewares.error}` }, { status: 400 });
    }

    // Caller's resolver, or the primary issuer over DNS-01 when Cloudflare credentials are set.
    const certResolver = parsed.data.certResolver
      ?? getDefaultCertResolver(await getSslConfig());

    const claim = hold === "claimable" ? { orgId, host: domainName, zone: false } : null;
    const [created] = await withClaim(claim, (exec) => exec
      .insert(domains)
      .values({
        id: nanoid(),
        appId,
        domain: domainName,
        ...proof,
        serviceName: parsed.data.serviceName,
        port: parsed.data.port,
        certResolver,
        redirectTo: parsed.data.redirectTo,
        redirectCode: parsed.data.redirectCode,
        pathPrefix: parsed.data.pathPrefix ?? null,
        stripPathPrefix: parsed.data.stripPathPrefix ?? false,
        middlewares: middlewares.value,
      })
      .returning());

    // Traefik labels route traffic, so domain changes need a redeploy.
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ domain: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "That domain and path are already routed" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating domain");
  }
}

const updateDomainSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1).regex(HOSTNAME_RE, "Invalid domain name").optional(),
  port: z.number().int().positive().nullable().optional(),
  certResolver: z.enum(CERT_RESOLVERS).optional(),
  redirectTo: z.string().url("Must be a valid URL").nullable().optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
  pathPrefix: pathPrefixSchema.optional(),
  stripPathPrefix: z.boolean().optional(),
  middlewares: middlewaresSchema.optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "domains");
    if (refused) return refused;

    const body = await request.json();
    const parsed = updateDomainSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { id, middlewares: requestedMiddlewares, ...fields } = parsed.data;
    const updates: typeof fields & {
      domain?: string;
      verificationToken?: string;
      verifiedAt?: Date | null;
      middlewares?: string | null;
    } = { ...fields };

    if (requestedMiddlewares !== undefined) {
      const middlewares = await checkMiddlewares(requestedMiddlewares, orgId);
      if ("error" in middlewares) {
        return NextResponse.json({ error: `Couldn't update domain. ${middlewares.error}` }, { status: 400 });
      }
      updates.middlewares = middlewares.value;
    }

    // A renamed domain starts over: its old proof says nothing about the new host.
    let claim: Claim | null = null;
    const current = fields.domain
      ? await db.query.domains.findFirst({
          where: and(eq(domains.id, id), eq(domains.appId, appId)),
          columns: { domain: true },
        })
      : null;
    if (fields.domain && current?.domain.toLowerCase() !== fields.domain.toLowerCase()) {
      const proof = await proofForNewDomain(fields.domain.toLowerCase(), orgId);
      if ("refusal" in proof) {
        return NextResponse.json({ error: `Couldn't update domain. ${proof.refusal}` }, { status: 400 });
      }
      const hold = await hostHoldByOtherOrg(fields.domain, orgId);
      if (hold === "taken") {
        return NextResponse.json({ error: `Couldn't update domain. ${HOST_TAKEN}` }, { status: 409 });
      }
      if (hold === "claimable" && !proof.verifiedAt) {
        return NextResponse.json({ error: `Couldn't update domain. ${HOST_CLAIMABLE}`, claimable: true }, { status: 409 });
      }
      if (hold === "claimable") claim = { orgId, host: fields.domain.toLowerCase(), zone: false };
      updates.domain = fields.domain.toLowerCase();
      Object.assign(updates, proof);
    }

    // Prevent self-redirect
    if (updates.redirectTo) {
      const existing = await db.query.domains.findFirst({
        where: and(eq(domains.id, id), eq(domains.appId, appId)),
        columns: { domain: true },
      });
      if (existing) {
        const redirectHost = new URL(updates.redirectTo).hostname;
        if (redirectHost === existing.domain) {
          return NextResponse.json({ error: "Can't redirect a domain to itself" }, { status: 400 });
        }
      }
    }

    const [updated] = await withClaim(claim, (exec) => exec
      .update(domains)
      .set(updates)
      .where(and(eq(domains.id, id), eq(domains.appId, appId)))
      .returning());

    if (!updated) {
      return apiError.notFound("domain");
    }

    // Domain changes require a redeploy to update Traefik labels
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ domain: updated });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That domain and path are already routed" }, { status: 409 });
    }
    return handleRouteError(error, "Error updating domain");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "domains");
    if (refused) return refused;

    const body = await request.json();
    const parsed = deleteDomainSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const [deleted] = await db
      .delete(domains)
      .where(
        and(
          eq(domains.id, parsed.data.id),
          eq(domains.appId, appId)
        )
      )
      .returning({ id: domains.id });

    if (!deleted) {
      return apiError.notFound("domain");
    }

    // Domain deletion requires a redeploy to remove Traefik labels
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting domain");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-domains" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "apps-domains" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-domains" });
