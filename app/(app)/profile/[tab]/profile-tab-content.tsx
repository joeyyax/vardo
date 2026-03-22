"use client";

import {
  AccountInfo,
  PasswordManagement,
  TwoFactorAuth,
  ActiveSessions,
  ApiTokens,
} from "../account-settings";
import { ThemeSwitcher } from "../theme-switcher";
import { GitHubConnection } from "../github-connection";

type ProfileTabContentProps = {
  tab: "account" | "security" | "tokens" | "connections" | "appearance";
  orgId: string;
};

export function ProfileTabContent({ tab, orgId }: ProfileTabContentProps) {
  switch (tab) {
    case "account":
      return (
        <div className="space-y-8">
          <AccountInfo />
          <PasswordManagement />
        </div>
      );
    case "security":
      return (
        <div className="space-y-8">
          <TwoFactorAuth />
          <ActiveSessions />
        </div>
      );
    case "tokens":
      return <ApiTokens orgId={orgId} />;
    case "connections":
      return <GitHubConnection />;
    case "appearance":
      return <ThemeSwitcher />;
  }
}
