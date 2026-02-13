import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { organizations, clients, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const INTAKE_DOMAIN = "intake.usescope.net";

/** Max file size for cloud URL downloads (bytes). */
export const CLOUD_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

/** Timeout for cloud URL downloads (ms). */
export const CLOUD_DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Generate a secure, unguessable intake email token.
 * Uses 48 chars for high entropy (per design spec).
 */
export function generateIntakeToken(): string {
  return nanoid(48);
}

/**
 * Build the full intake email address from a token.
 */
export function getIntakeEmailAddress(token: string): string {
  return `${token}@${INTAKE_DOMAIN}`;
}

// Entity resolution result from token lookup
export type IntakeEntity =
  | { type: "org"; id: string; orgId: string }
  | { type: "client"; id: string; orgId: string }
  | { type: "project"; id: string; orgId: string; clientId: string };

/**
 * Get or create the intake email token for an organization.
 */
export async function getOrCreateIntakeToken(
  orgId: string
): Promise<{ token: string; email: string }> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { intakeEmailToken: true },
  });

  if (org?.intakeEmailToken) {
    return {
      token: org.intakeEmailToken,
      email: getIntakeEmailAddress(org.intakeEmailToken),
    };
  }

  const token = generateIntakeToken();

  await db
    .update(organizations)
    .set({ intakeEmailToken: token, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));

  return {
    token,
    email: getIntakeEmailAddress(token),
  };
}

/**
 * Get or create the intake email token for a client.
 */
export async function getOrCreateClientIntakeToken(
  clientId: string
): Promise<{ token: string; email: string }> {
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { intakeEmailToken: true },
  });

  if (client?.intakeEmailToken) {
    return {
      token: client.intakeEmailToken,
      email: getIntakeEmailAddress(client.intakeEmailToken),
    };
  }

  const token = generateIntakeToken();

  await db
    .update(clients)
    .set({ intakeEmailToken: token, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  return {
    token,
    email: getIntakeEmailAddress(token),
  };
}

/**
 * Get or create the intake email token for a project.
 */
export async function getOrCreateProjectIntakeToken(
  projectId: string
): Promise<{ token: string; email: string }> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { intakeEmailToken: true },
  });

  if (project?.intakeEmailToken) {
    return {
      token: project.intakeEmailToken,
      email: getIntakeEmailAddress(project.intakeEmailToken),
    };
  }

  const token = generateIntakeToken();

  await db
    .update(projects)
    .set({ intakeEmailToken: token, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  return {
    token,
    email: getIntakeEmailAddress(token),
  };
}

/**
 * Look up which entity (org, client, or project) owns a given intake email token.
 * Queries all three tables. Returns null if no match.
 */
export async function findEntityByIntakeToken(
  token: string
): Promise<IntakeEntity | null> {
  // Check organizations first (most common)
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.intakeEmailToken, token),
    columns: { id: true },
  });
  if (org) {
    return { type: "org", id: org.id, orgId: org.id };
  }

  // Check clients
  const client = await db.query.clients.findFirst({
    where: eq(clients.intakeEmailToken, token),
    columns: { id: true, organizationId: true },
  });
  if (client) {
    return { type: "client", id: client.id, orgId: client.organizationId };
  }

  // Check projects
  const project = await db.query.projects.findFirst({
    where: eq(projects.intakeEmailToken, token),
    columns: { id: true, clientId: true },
    with: {
      client: { columns: { organizationId: true } },
    },
  });
  if (project) {
    return {
      type: "project",
      id: project.id,
      orgId: project.client.organizationId,
      clientId: project.clientId,
    };
  }

  return null;
}

/**
 * @deprecated Use findEntityByIntakeToken instead
 */
export async function findOrgByIntakeToken(
  token: string
): Promise<{ id: string } | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.intakeEmailToken, token),
    columns: { id: true },
  });

  return org ?? null;
}
