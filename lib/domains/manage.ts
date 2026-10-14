// Domain writes for one app, shared by the REST routes and the MCP tools.
// Both entry points route traffic through Traefik labels, so they must apply the
// same ownership, proof and compose guards. A divergence here hands a host to the
// wrong organization.

import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, domains, organizations } from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/api/error-response";
import { HOSTNAME_RE } from "@/lib/security/hostname";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { CERT_RESOLVERS, getDefaultCertResolver, getSslConfig } from "@/lib/system-settings";
import { hostHoldByOtherOrg, withClaim, type Claim, type Exec } from "./claim";
import { proofForNewDomain } from "./context";
import { middlewareProblem, serializeMiddlewares } from "./middlewares";
import { normalizePathPrefix } from "./path-prefix";

const HOST_TAKEN = "Another organization already routes that domain.";
const HOST_CLAIMABLE =
  "Another organization added it but hasn't verified it. Verify it under Settings → Domains to claim it.";
const COMPOSE_READ_ONLY =
  "The app's compose file sets this domain. Change its Traefik label there, or manage it in Vardo.";
const DISABLED_PRIMARY = "A disabled domain can't be primary. Enable it first.";

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

// Traefik middleware references, e.g. "cloudflare-only@file".
const middlewaresSchema = z.array(z.string().trim().min(1).max(100)).max(10).nullable();

export const createDomainSchema = z
  .object({
    domain: z.string().min(1, "Domain is required").regex(HOSTNAME_RE, "Invalid domain name"),
    serviceName: z.string().optional(),
    port: z.number().int().positive().optional(),
    certResolver: z.enum(CERT_RESOLVERS).optional(),
    redirectTo: z.string().url("Must be a valid URL").optional(),
    redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
    pathPrefix: pathPrefixSchema.optional(),
    stripPathPrefix: z.boolean().optional(),
    middlewares: middlewaresSchema.optional(),
  })
  .strict();

export const updateDomainSchema = z
  .object({
    id: z.string().min(1),
    domain: z.string().min(1).regex(HOSTNAME_RE, "Invalid domain name").optional(),
    port: z.number().int().positive().nullable().optional(),
    certResolver: z.enum(CERT_RESOLVERS).optional(),
    redirectTo: z.string().url("Must be a valid URL").nullable().optional(),
    redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
    pathPrefix: pathPrefixSchema.optional(),
    stripPathPrefix: z.boolean().optional(),
    middlewares: middlewaresSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type DomainInput = z.infer<typeof createDomainSchema>;
export type DomainPatch = z.infer<typeof updateDomainSchema>;

/** The app a domain write targets, with the flags the guards read. */
export type DomainSubject = {
  id: string;
  organizationId: string;
  isSystemManaged: boolean | null;
};

export type DomainResult =
  | { ok: true; kind: "domain"; domain: typeof domains.$inferSelect }
  | { ok: true; kind: "removed"; domainId: string }
  | { ok: false; status: number; error: string; claimable?: boolean };

export type DomainFailure = Extract<DomainResult, { ok: false }>;
export type DomainWrite = Extract<DomainResult, { ok: true; kind: "domain" }>;

const refused = (status: number, error: string, claimable = false): DomainFailure => ({
  ok: false,
  status,
  error,
  ...(claimable ? { claimable: true } : {}),
});

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

/** Traefik labels route traffic, so domain changes need a redeploy. */
async function markNeedsRedeploy(appId: string): Promise<void> {
  await db
    .update(apps)
    .set({ needsRedeploy: true, updatedAt: new Date() })
    .where(eq(apps.id, appId));
}

/** A redirect that points at the domain itself would loop forever. */
function selfRedirect(host: string, redirectTo: string | null | undefined): boolean {
  if (!redirectTo) return false;
  try {
    return new URL(redirectTo).hostname === host.toLowerCase();
  } catch {
    return false;
  }
}

/** The row a compose-sourced domain of the same route, if the write adopts it. */
async function composeRowToAdopt(appId: string, domain: string, pathPrefix: string | null) {
  return db.query.domains.findFirst({
    where: and(
      eq(domains.appId, appId),
      eq(domains.source, "compose"),
      eq(domains.domain, domain),
      pathPrefix ? eq(domains.pathPrefix, pathPrefix) : isNull(domains.pathPrefix),
    ),
    columns: { id: true, composeRouter: true },
  });
}

/** Adds a Vardo-managed domain to an app. */
export async function addDomain(app: DomainSubject, input: DomainInput): Promise<DomainResult> {
  const refusal = systemManagedRefusal(app, "domains");
  if (refusal) return refused(403, refusal);

  const orgId = app.organizationId;
  const domainName = input.domain.toLowerCase();

  if (selfRedirect(domainName, input.redirectTo)) {
    return refused(400, "Redirect target can't be the same domain (infinite redirect loop)");
  }

  const proof = await proofForNewDomain(domainName, orgId);
  if ("refusal" in proof) return refused(400, `Couldn't add domain. ${proof.refusal}`);

  const hold = await hostHoldByOtherOrg(domainName, orgId);
  if (hold === "taken") return refused(409, `Couldn't add domain. ${HOST_TAKEN}`);
  // Unverified rows elsewhere yield only to a host this org proved through a verified zone.
  if (hold === "claimable" && !proof.verifiedAt) {
    return refused(409, `Couldn't add domain. ${HOST_CLAIMABLE}`, true);
  }

  const middlewares = await checkMiddlewares(input.middlewares ?? null, orgId);
  if ("error" in middlewares) return refused(400, `Couldn't add domain. ${middlewares.error}`);

  // Caller's resolver, or the primary issuer over DNS-01 when Cloudflare credentials are set.
  const certResolver = input.certResolver ?? getDefaultCertResolver(await getSslConfig());

  // "Manage in Vardo": the managed row replaces the compose row for the same route.
  const pathPrefix = input.pathPrefix ?? null;
  const adopted = await composeRowToAdopt(app.id, domainName, pathPrefix);

  const claim: Claim | null = hold === "claimable" ? { orgId, host: domainName, zone: false } : null;
  const insertRow = async (exec: Exec) => {
    if (adopted) await exec.delete(domains).where(and(eq(domains.id, adopted.id), eq(domains.source, "compose")));
    return exec
      .insert(domains)
      .values({
        id: nanoid(),
        appId: app.id,
        domain: domainName,
        composeRouter: adopted?.composeRouter ?? null,
        ...proof,
        serviceName: input.serviceName,
        port: input.port,
        certResolver,
        redirectTo: input.redirectTo,
        redirectCode: input.redirectCode,
        pathPrefix,
        stripPathPrefix: input.stripPathPrefix ?? false,
        middlewares: middlewares.value,
      })
      .returning();
  };

  try {
    const [created] = await withClaim(claim, (exec) =>
      adopted && exec === db ? db.transaction((tx) => insertRow(tx)) : insertRow(exec));
    await markNeedsRedeploy(app.id);
    return { ok: true, kind: "domain", domain: created };
  } catch (error) {
    if (isUniqueViolation(error)) return refused(409, "That domain and path are already routed");
    throw error;
  }
}

/** Edits a Vardo-managed domain. Compose-sourced rows are read-only here. */
export async function editDomain(app: DomainSubject, input: DomainPatch): Promise<DomainResult> {
  const refusal = systemManagedRefusal(app, "domains");
  if (refusal) return refused(403, refusal);

  const orgId = app.organizationId;
  const { id, domain: requestedDomain, middlewares: requestedMiddlewares, ...fields } = input;

  const current = await db.query.domains.findFirst({
    where: and(eq(domains.id, id), eq(domains.appId, app.id)),
    columns: { domain: true, source: true, composeRouter: true },
  });
  if (!current) return refused(404, "domain");
  if (current.source === "compose") return refused(409, COMPOSE_READ_ONLY);
  // The compose label would keep routing the host.
  if (fields.enabled === false && current.composeRouter) {
    return refused(
      409,
      `Couldn't disable domain. The app's compose file also routes it with router "${current.composeRouter}". Remove that label first.`,
    );
  }

  const updates: typeof fields & {
    domain?: string;
    verificationToken?: string;
    verifiedAt?: Date | null;
    middlewares?: string | null;
    isPrimary?: boolean;
  } = { ...fields };
  // A disabled domain can't be primary.
  if (fields.enabled === false) updates.isPrimary = false;

  if (requestedMiddlewares !== undefined) {
    const middlewares = await checkMiddlewares(requestedMiddlewares, orgId);
    if ("error" in middlewares) return refused(400, `Couldn't update domain. ${middlewares.error}`);
    updates.middlewares = middlewares.value;
  }

  // A host is stored lowercase. A renamed one starts over: its old proof says nothing about the new host.
  const renamed = requestedDomain ? requestedDomain.toLowerCase() !== current.domain.toLowerCase() : false;
  let claim: Claim | null = null;
  if (renamed && requestedDomain) {
    const host = requestedDomain.toLowerCase();
    const proof = await proofForNewDomain(host, orgId);
    if ("refusal" in proof) return refused(400, `Couldn't update domain. ${proof.refusal}`);
    const hold = await hostHoldByOtherOrg(host, orgId);
    if (hold === "taken") return refused(409, `Couldn't update domain. ${HOST_TAKEN}`);
    if (hold === "claimable" && !proof.verifiedAt) {
      return refused(409, `Couldn't update domain. ${HOST_CLAIMABLE}`, true);
    }
    if (hold === "claimable") claim = { orgId, host, zone: false };
    updates.domain = host;
    Object.assign(updates, proof);
  }

  if (updates.redirectTo && selfRedirect(current.domain, updates.redirectTo)) {
    return refused(400, "Can't redirect a domain to itself");
  }

  try {
    const [updated] = await withClaim(claim, (exec) =>
      exec
        .update(domains)
        .set(updates)
        .where(and(eq(domains.id, id), eq(domains.appId, app.id), eq(domains.source, "vardo")))
        .returning(),
    );
    if (!updated) return refused(404, "domain");
    await markNeedsRedeploy(app.id);
    return { ok: true, kind: "domain", domain: updated };
  } catch (error) {
    if (isUniqueViolation(error)) return refused(409, "That domain and path are already routed");
    throw error;
  }
}

/** Removes a Vardo-managed domain and its route. */
export async function removeDomain(app: DomainSubject, id: string): Promise<DomainResult> {
  const refusal = systemManagedRefusal(app, "domains");
  if (refusal) return refused(403, refusal);

  const row = await db.query.domains.findFirst({
    where: and(eq(domains.id, id), eq(domains.appId, app.id)),
    columns: { id: true, source: true },
  });
  if (!row) return refused(404, "domain");
  if (row.source === "compose") return refused(409, COMPOSE_READ_ONLY);

  const [deleted] = await db
    .delete(domains)
    .where(and(eq(domains.id, id), eq(domains.appId, app.id)))
    .returning({ id: domains.id });

  if (!deleted) return refused(404, "domain");
  await markNeedsRedeploy(app.id);
  return { ok: true, kind: "removed", domainId: id };
}

/** Points the app's display URL at one of its Vardo-managed domains. */
export async function setPrimaryDomain(app: DomainSubject, domainId: string): Promise<DomainWrite | DomainFailure> {
  const refusal = systemManagedRefusal(app, "domains");
  if (refusal) return refused(403, refusal);

  const row = await db.query.domains.findFirst({
    where: and(eq(domains.id, domainId), eq(domains.appId, app.id)),
    columns: { id: true, source: true, enabled: true },
  });
  if (!row) return refused(404, "domain");
  if (row.source === "compose") return refused(409, COMPOSE_READ_ONLY);
  if (!row.enabled) return refused(409, DISABLED_PRIMARY);

  await db.update(domains).set({ isPrimary: false }).where(eq(domains.appId, app.id));
  const [domain] = await db
    .update(domains)
    .set({ isPrimary: true })
    .where(and(eq(domains.id, domainId), eq(domains.appId, app.id)))
    .returning();

  return { ok: true, kind: "domain", domain };
}

