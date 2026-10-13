"use client";

import type { SecurityHeaderConfig } from "@/lib/security/response-headers";
import { SecurityFindings } from "./security-findings";
import { SecuritySettings } from "./security-settings";

type AppSecurityProps = {
  appId: string;
  orgId: string;
  /** Which sub-tab to render. "findings" for the scans + activity page, "settings" for the three cards. */
  tab: "findings" | "settings";
  initialSecurityHeaders: SecurityHeaderConfig;
  securityHeadersLive: boolean;
};

/** The app Security group: switches between Findings and Settings based on the active sub-tab. */
export function AppSecurity({ appId, orgId, tab, initialSecurityHeaders, securityHeadersLive }: AppSecurityProps) {
  if (tab === "settings") {
    return (
      <SecuritySettings
        orgId={orgId}
        appId={appId}
        initialSecurityHeaders={initialSecurityHeaders}
        securityHeadersLive={securityHeadersLive}
      />
    );
  }
  return <SecurityFindings orgId={orgId} appId={appId} />;
}