"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { GuardHistory } from "@/components/probe-guard/guard-history";
import { RangePicker } from "@/components/range-picker";
import { GUARD_RANGES, rangeLabel, type GuardRange } from "@/lib/probe-guard/range";
import { parseGuardRange } from "@/lib/probe-guard/range";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, Suspense } from "react";

const ENDPOINT = "/api/v1/admin/probe-guard/history";
const BAN_URL = (id: string) => `/api/v1/admin/probe-guard/bans/${id}`;
const ALLOW_URL = "/api/v1/admin/probe-guard/allowlist";

function AdminSecurityInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const range = parseGuardRange(params.get("range"));
  const setRange = useCallback(
    (next: GuardRange) => {
      const q = new URLSearchParams(params.toString());
      q.set("range", next);
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const options = GUARD_RANGES.map((value) => ({ value, label: rangeLabel(value) }));

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
        <div className="flex items-center justify-between mb-3">
          <h3 className="type-h4">Across all apps</h3>
          <RangePicker options={options} value={range} onChange={setRange} label="Time range" />
        </div>
        <GuardHistory
          endpoint={`${ENDPOINT}?range=${range}`}
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