"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { GuardHistory } from "@/components/probe-guard/guard-history";
import { Suspense } from "react";

const ENDPOINT = "/api/v1/admin/probe-guard/history";
const BAN_URL = (id: string) => `/api/v1/admin/probe-guard/bans/${id}`;
const ALLOW_URL = "/api/v1/admin/probe-guard/allowlist";

function AdminSecurityInner() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-h2">Security</h2>
          <p className="text-sm text-muted-foreground">
            Who is banned and what&apos;s being probed, across every app. Status is on the Overview.
          </p>
        </div>
        <Link
          href="/admin/probe-guard"
          className="shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Probe guard settings
        </Link>
      </div>

      <Card variant="surface" className="p-4">
        <h3 className="type-h4 mb-3">Across all apps</h3>
        <GuardHistory
          endpoint={ENDPOINT}
          banUrl={BAN_URL}
          allowUrl={ALLOW_URL}
          canBanPermanently
          showApps
        />
      </Card>
    </div>
  );
}

/** Cross-app bans, history, what was probed and top sources. */
export function AdminSecurity() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading security</span>
      </div>
    }>
      <AdminSecurityInner />
    </Suspense>
  );
}