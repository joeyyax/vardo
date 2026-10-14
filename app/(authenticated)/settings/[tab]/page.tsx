import { notFound, redirect } from "next/navigation";
import { getUserOrganizations } from "@/lib/auth/session";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadOrgDomainSettings, loadOrgGeneralSettings } from "@/lib/app-services/settings";
import { listBackupAppOptions } from "@/lib/app-services/backups";
import { listProjectOptions } from "@/lib/app-services/projects";
import { loadInvitationsTab, loadTeamTab } from "@/lib/app-services/team";
import { OrgEnvVarsEditor } from "../org-env-vars";
import { OrgDomainEditor } from "../org-domain-editor";
import { NotificationChannelsEditor } from "../notification-channels";
import { DigestSettingsEditor } from "../digest-settings";
import { NotificationCategoriesEditor } from "../notification-categories";
import { TeamMembers } from "@/app/(authenticated)/team/team-members";
import { InvitationsPanel } from "../invitations";
import { OrgGeneralSettings } from "../org-general-settings";
import { OrgResourceProfiles } from "../org-resource-profiles";
import { BackupPage } from "@/components/backups/backup-page";

const VALID_TABS = ["general", "variables", "domains", "backups", "notifications", "team", "invitations"] as const;
type ValidTab = (typeof VALID_TABS)[number];

/** Feature flag each tab needs, where it has one. */
const TAB_GATES: Partial<Record<ValidTab, FeatureFlag>> = {
  team: "teams",
  invitations: "teams",
};

export default async function OrgSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!VALID_TABS.includes(tab as ValidTab)) {
    notFound();
  }

  const gate = TAB_GATES[tab as ValidTab];
  if (gate && !(await isFeatureEnabledAsync(gate))) {
    notFound();
  }

  const actor = await currentActor();

  if (!actor) {
    redirect("/onboarding");
  }

  const orgId = actor.org.id;

  switch (tab as ValidTab) {
    case "general": {
      const settings = await pageData(loadOrgGeneralSettings(actor));
      return (
        <div className="space-y-4">
          <OrgGeneralSettings
            orgId={orgId}
            orgName={settings.name}
            orgTimeZone={settings.timeZone}
            instanceTimeZone={settings.instanceTimeZone}
            githubFeedback={settings.githubFeedback}
          />
          <OrgResourceProfiles
            orgId={orgId}
            memoryProfile={settings.memoryProfile}
            autoMaxMb={settings.memoryAutoMaxMb}
          />
        </div>
      );
    }

    case "variables":
      return <OrgEnvVarsEditor orgId={orgId} />;

    case "domains": {
      const settings = await pageData(loadOrgDomainSettings(actor));
      return (
        <OrgDomainEditor
          orgId={orgId}
          defaultDomain={settings.defaultDomain}
          sslEnabled={settings.sslEnabled}
          serverIP={settings.serverIP}
        />
      );
    }

    case "backups": {
      const appList = await pageData(listBackupAppOptions(actor));
      return <BackupPage scope="org" orgId={orgId} apps={appList} />;
    }

    case "notifications": {
      const projectOptions = (await pageData(listProjectOptions(actor)))
        .map((p) => ({ id: p.id, name: p.displayName || p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return (
        <div className="space-y-4">
          <NotificationChannelsEditor orgId={orgId} projects={projectOptions} />
          <NotificationCategoriesEditor orgId={orgId} />
          <DigestSettingsEditor orgId={orgId} />
        </div>
      );
    }

    case "team": {
      const [organizations, team] = await Promise.all([getUserOrganizations(), pageData(loadTeamTab(actor))]);
      return (
        <TeamMembers
          members={team.members}
          orgId={orgId}
          orgName={actor.org.name}
          currentRole={actor.membership.role}
          currentUserId={actor.userId}
          organizations={organizations}
          embedded
          systemOrg={team.systemOrg}
          instanceAdmin={team.instanceAdmin}
        />
      );
    }

    case "invitations": {
      const data = await pageData(loadInvitationsTab(actor));
      return (
        <InvitationsPanel
          orgId={orgId}
          orgName={actor.org.name}
          currentRole={actor.membership.role}
          invitations={data.invitations}
          emailConfigured={data.emailConfigured}
          systemOrg={data.systemOrg}
        />
      );
    }
  }
}
