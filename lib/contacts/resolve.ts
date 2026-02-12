import { db } from "@/lib/db";
import { clientContacts, projectContacts } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";

export type ResolvedContact = {
  id: string;
  clientId: string;
  type: "primary" | "billing" | "other";
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
};

export type ContactResolution = {
  contacts: ResolvedContact[];
  source: "project" | "client";
};

const TYPE_ORDER = sql`CASE ${clientContacts.type} WHEN 'primary' THEN 0 WHEN 'billing' THEN 1 ELSE 2 END`;

/**
 * Resolves contacts for a project. If the project has explicit contact
 * overrides in `projectContacts`, those are returned (source: "project").
 * Otherwise, all contacts from the parent client are returned (source: "client").
 */
export async function resolveProjectContacts(
  projectId: string,
  clientId: string
): Promise<ContactResolution> {
  // Check for project-level overrides
  const projectOverrides = await db
    .select({
      id: clientContacts.id,
      clientId: clientContacts.clientId,
      type: clientContacts.type,
      name: clientContacts.name,
      email: clientContacts.email,
      phone: clientContacts.phone,
      title: clientContacts.title,
    })
    .from(projectContacts)
    .innerJoin(clientContacts, eq(projectContacts.contactId, clientContacts.id))
    .where(eq(projectContacts.projectId, projectId))
    .orderBy(TYPE_ORDER, asc(clientContacts.name));

  if (projectOverrides.length > 0) {
    return {
      contacts: projectOverrides as ResolvedContact[],
      source: "project",
    };
  }

  // Fall back to all client contacts
  const allClientContacts = await db
    .select()
    .from(clientContacts)
    .where(eq(clientContacts.clientId, clientId))
    .orderBy(TYPE_ORDER, asc(clientContacts.name));

  return {
    contacts: allClientContacts as ResolvedContact[],
    source: "client",
  };
}
