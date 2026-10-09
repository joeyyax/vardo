import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { orgDomains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { loadInstanceHosts, loadVerifiedZones } from "@/lib/domains/context";
import { newChallengeToken, refusedHost, verificationView } from "@/lib/domains/ownership";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getInstanceBaseDomain } from "@/lib/domain-monitoring/base-domain";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const addSchema = z.object({
  domain: z
    .string()
    .min(1)
    .transform((d) => d.trim().toLowerCase())
    .refine(
      (d) =>
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
          d
        ),
      { message: "Invalid domain format" }
    ),
}).strict();

const patchSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
}).strict();

// GET — org domains, including the default before it's persisted
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const rows = await db.query.orgDomains.findMany({
      where: eq(orgDomains.organizationId, orgId),
    });

    const hasDefault = rows.some((r) => r.isDefault);
    if (!hasDefault) {
      rows.unshift({
        id: "__default__",
        organizationId: orgId,
        domain: await getInstanceBaseDomain(),
        isDefault: true,
        enabled: true,
        verified: false,
        verificationToken: null,
        verifiedAt: null,
        createdAt: new Date(),
      });
    }

    rows.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const inst = await loadInstanceHosts();
    const zones = await loadVerifiedZones(orgId);
    const trust = { trusted: org.organization.trusted };
    return NextResponse.json({
      domains: rows.map((r) => ({
        ...r,
        // The default is the instance's own zone; it never needs proof.
        verification: r.isDefault
          ? { state: "not-required" as const, verifiedAt: null, recordName: "", recordValue: null }
          : verificationView(r, inst, trust, zones.filter((z) => z !== r.domain.toLowerCase())),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST — add a custom domain
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.domains.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const domain = parsed.data.domain;

    if (domain === (await getInstanceBaseDomain()).toLowerCase()) {
      return NextResponse.json(
        { error: "Can't add the default domain as a custom domain" },
        { status: 400 }
      );
    }
    const refusal = refusedHost(domain, await loadInstanceHosts());
    if (refusal) {
      return NextResponse.json({ error: `Couldn't add domain. ${refusal}` }, { status: 400 });
    }

    const [created] = await db
      .insert(orgDomains)
      .values({
        id: nanoid(),
        organizationId: orgId,
        domain,
        isDefault: false,
        enabled: true,
        verified: false,
        verificationToken: newChallengeToken(),
      })
      .returning();

    return NextResponse.json({ domain: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "Domain already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error);
  }
}

// PATCH — toggle enabled/disabled
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  const body = await request.json();

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error);
  }

  try {
    const org = await verifyOrgAccess(orgId, "org.domains.manage");
    if (!org) return apiError.forbidden();

    // The default domain is created on its first toggle. It's the instance's zone, so it's never marked verified.
    if (parsed.data.id === "__default__") {
      const [created] = await db
        .insert(orgDomains)
        .values({
          id: nanoid(),
          organizationId: orgId,
          domain: await getInstanceBaseDomain(),
          isDefault: true,
          enabled: parsed.data.enabled,
          verified: false,
        })
        .returning();

      return NextResponse.json({ domain: created });
    }

    const [updated] = await db
      .update(orgDomains)
      .set({ enabled: parsed.data.enabled })
      .where(
        and(
          eq(orgDomains.id, parsed.data.id),
          eq(orgDomains.organizationId, orgId)
        )
      )
      .returning();

    if (!updated) {
      return apiError.notFound("domain");
    }

    return NextResponse.json({ domain: updated });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Persisted by a concurrent request; update it.
      try {
        const [updated] = await db
          .update(orgDomains)
          .set({ enabled: parsed.data.enabled })
          .where(
            and(
              eq(orgDomains.organizationId, orgId),
              eq(orgDomains.isDefault, true)
            )
          )
          .returning();

        if (updated) return NextResponse.json({ domain: updated });
      } catch {
      }
    }
    return handleRouteError(error);
  }
}

// DELETE — remove a custom domain. The default can't be deleted.
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.domains.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const deleteSchema = z.object({ id: z.string().min(1) }).strict();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { id } = parsed.data;

    const existing = await db.query.orgDomains.findFirst({
      where: and(
        eq(orgDomains.id, id),
        eq(orgDomains.organizationId, orgId)
      ),
    });

    if (!existing) {
      return apiError.notFound("domain");
    }

    if (existing.isDefault) {
      return NextResponse.json(
        { error: "Can't delete the default domain" },
        { status: 400 }
      );
    }

    await db
      .delete(orgDomains)
      .where(
        and(eq(orgDomains.id, id), eq(orgDomains.organizationId, orgId))
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-domains" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-domains" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-domains" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/domains" });
