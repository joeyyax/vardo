import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { githubAppInstallations, githubInstallationOrgs } from "@/lib/db/schema";
import { can } from "@/lib/auth/permissions";
import type { CloneInstallation } from "./clone-auth";

export const LINK_INSTALLATION_HINT =
  "Link a GitHub App installation that covers the repo under User settings → Connections → GitHub, with this organization selected.";

/** Installations linked to the org, with account logins from the user-side rows. */
export async function orgInstallations(organizationId: string): Promise<CloneInstallation[]> {
  const links = await db.query.githubInstallationOrgs.findMany({
    where: eq(githubInstallationOrgs.organizationId, organizationId),
    columns: { installationId: true },
  });
  const ids = [...new Set(links.map((l) => l.installationId))];
  if (ids.length === 0) return [];

  const rows = await db.query.githubAppInstallations.findMany({
    where: inArray(githubAppInstallations.installationId, ids),
    columns: { installationId: true, accountLogin: true },
  });
  return ids.map((installationId) => ({
    installationId,
    accountLogin: rows.find((r) => r.installationId === installationId)?.accountLogin ?? `installation ${installationId}`,
  }));
}

/** Org ids the installation is linked to. */
export async function orgsForInstallation(installationId: number): Promise<string[]> {
  const links = await db.query.githubInstallationOrgs.findMany({
    where: eq(githubInstallationOrgs.installationId, installationId),
    columns: { organizationId: true },
  });
  return links.map((l) => l.organizationId);
}

export async function linkInstallationToOrg(organizationId: string, installationId: number, userId: string): Promise<void> {
  await db
    .insert(githubInstallationOrgs)
    .values({ id: nanoid(), organizationId, installationId, linkedByUserId: userId })
    .onConflictDoNothing();
}

export async function unlinkInstallationFromOrg(organizationId: string, installationId: number): Promise<void> {
  await db
    .delete(githubInstallationOrgs)
    .where(and(eq(githubInstallationOrgs.organizationId, organizationId), eq(githubInstallationOrgs.installationId, installationId)));
}

/** Links the installation to the user's current org when their role there manages org settings. */
export async function linkToCurrentOrgIfAdmin(
  current: { organization: { id: string }; membership: { role: string } } | null,
  installationId: number,
  userId: string,
): Promise<boolean> {
  if (!current || !can(current.membership.role, "org.settings")) return false;
  await linkInstallationToOrg(current.organization.id, installationId, userId);
  return true;
}
