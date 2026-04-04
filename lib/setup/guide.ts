// ---------------------------------------------------------------------------
// Get Started guide — step definitions and completion checks
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, plugins } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  getGitHubAppConfig,
  getEmailProviderConfig,
  getInstanceConfig,
  getBackupStorageConfig,
} from "@/lib/system-settings";

export type GuideStepCategory = "core" | "recommended" | "optional";

export type GuideStep = {
  id: string;
  title: string;
  description: string;
  href: string;
  category: GuideStepCategory;
};

export const GUIDE_STEPS: GuideStep[] = [
  {
    id: "plugins",
    title: "Install plugins",
    description: "Choose a quick-start bundle or pick plugins individually",
    href: "/admin/plugins",
    category: "core",
  },
  {
    id: "github",
    title: "Connect GitHub",
    description: "Link a GitHub App for repository access and auto-deploy",
    href: "/admin/settings/github",
    category: "recommended",
  },
  {
    id: "email",
    title: "Set up email",
    description: "Configure SMTP or an email API for notifications and invites",
    href: "/admin/settings/email",
    category: "recommended",
  },
  {
    id: "domain",
    title: "Configure domain",
    description: "Set your base domain and verify DNS for automatic HTTPS",
    href: "/admin/settings/domain",
    category: "recommended",
  },
  {
    id: "backup",
    title: "Configure backups",
    description: "Set up S3, R2, or B2 storage for volume snapshots",
    href: "/admin/settings/backup",
    category: "recommended",
  },
  {
    id: "first-app",
    title: "Deploy your first app",
    description:
      "Create a project and deploy from Git, Docker image, or compose",
    href: "/projects",
    category: "core",
  },
];

/**
 * Check which guide steps have been completed.
 * Returns a Set of step IDs that are done.
 */
export async function getCompletedSteps(): Promise<Set<string>> {
  const [
    pluginCount,
    githubConfig,
    emailConfig,
    instanceConfig,
    backupConfig,
    appCount,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(plugins)
      .where(eq(plugins.enabled, true))
      .then(([r]) => Number(r.count)),
    getGitHubAppConfig(),
    getEmailProviderConfig(),
    getInstanceConfig(),
    getBackupStorageConfig(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(apps)
      .then(([r]) => Number(r.count)),
  ]);

  const completed = new Set<string>();

  if (pluginCount > 0) completed.add("plugins");
  if (githubConfig !== null) completed.add("github");
  if (emailConfig !== null) completed.add("email");
  if (instanceConfig.baseDomain) completed.add("domain");
  if (backupConfig !== null) completed.add("backup");
  if (appCount > 0) completed.add("first-app");

  return completed;
}
