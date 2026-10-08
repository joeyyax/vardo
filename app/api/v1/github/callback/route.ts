import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import { getAppOctokit, verifyInstallationState } from "@/lib/git-integration/app";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";

const log = logger.child("github-callback");

// GET /api/v1/github/callback — GitHub redirects here after app installation
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Installs send installation_id, setup_action and state. OAuth during install adds code.
  const installationId = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action");
  const state = searchParams.get("state");

  log.info("params:", {
    installation_id: installationId,
    setup_action: setupAction,
    state: state ? "present" : "missing",
    code: searchParams.get("code") ? "present" : "missing",
  });

  if (!installationId || !state) {
    log.error("Missing installation_id or state");
    return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
  }

  // Verify HMAC state
  const stateData = verifyInstallationState(state);
  if (!stateData) {
    log.error("Invalid or expired state");
    return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
  }

  // Verify the session matches the state
  let userId: string;
  try {
    const session = await requireSession();
    if (session.user.id !== stateData.userId) {
      log.error("Session user mismatch");
      return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
    }
    userId = session.user.id;
    // installation_id is caller-supplied and GitHub doesn't tie it to this user.
    if (!(await isAppAdmin())) {
      log.error("Non-admin tried to link an installation");
      return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
    }
  } catch {
    log.error("Not authenticated");
    return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
  }

  // Handle "request" action (org admin approval needed)
  if (setupAction === "request") {
    return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=pending`);
  }

  try {
    const octokit = await getAppOctokit();
    const { data: installation } = await octokit.rest.apps.getInstallation({
      installation_id: parseInt(installationId, 10),
    });

    const account = installation.account;
    if (!account) {
      log.error("No account on installation");
      return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
    }

    // Account shape differs between User/Org and Enterprise.
    const accountLogin =
      "login" in account ? account.login : account.slug ?? "unknown";
    const accountType =
      "type" in account ? (account.type ?? "User") : "Enterprise";
    const accountAvatarUrl = account.avatar_url || null;

    // Upsert handles reinstalls.
    await db
      .insert(githubAppInstallations)
      .values({
        id: nanoid(),
        userId,
        installationId: parseInt(installationId, 10),
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

    log.info(
      `Saved installation ${installationId} for user ${userId} (${accountLogin})`
    );

    return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=connected`);
  } catch (error) {
    log.error("Error:", error);
    return NextResponse.redirect(`${baseUrl}/user/settings/connections?github=error`);
  }
}
