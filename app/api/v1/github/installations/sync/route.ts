import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { getAppOctokit } from "@/lib/git-integration/app";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";

const log = logger.child("github-installations-sync");

// GET /api/v1/github/installations/sync — Sync existing GitHub App installations for current user
export async function GET() {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const octokit = await getAppOctokit();

    // List all installations of this GitHub App
    const { data } = await octokit.rest.apps.listInstallations({
      per_page: 100,
    });

    // Get existing installations for this user
    const existing = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.userId, userId),
    });
    const existingIds = new Set(existing.map((i) => i.installationId));

    let synced = 0;

    for (const installation of data) {
      if (existingIds.has(installation.id)) continue;

      const account = installation.account;
      if (!account) continue;

      // Account type varies between User/Org and Enterprise
      const acct = account as Record<string, unknown>;
      const accountLogin =
        (acct.login as string) ?? (acct.slug as string) ?? "unknown";
      const accountType =
        (acct.type as string) ?? "User";
      const accountAvatarUrl =
        (acct.avatar_url as string) || null;

      await db
        .insert(githubAppInstallations)
        .values({
          id: nanoid(),
          userId,
          installationId: installation.id,
          accountLogin,
          accountType,
          accountAvatarUrl,
        })
        .onConflictDoUpdate({
          target: [
            githubAppInstallations.userId,
            githubAppInstallations.installationId,
          ],
          set: {
            accountLogin,
            accountType,
            accountAvatarUrl,
            updatedAt: new Date(),
          },
        });

      synced++;
    }

    log.info(`Synced ${synced} installation(s) for user ${userId}`);

    // Return the updated list
    const installations = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.userId, userId),
    });

    return NextResponse.json({ installations, synced });
  } catch (error) {
    return handleRouteError(error, "Error syncing GitHub installations");
  }
}
