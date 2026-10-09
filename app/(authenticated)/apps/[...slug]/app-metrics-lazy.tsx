"use client";

import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { SkeletonGroup } from "@/components/ui/skeleton";

/** Recharts loads when the metrics panel renders, not with the page. */
export const AppMetrics = dynamic(() => import("./app-metrics").then((m) => m.AppMetrics), {
  ssr: false,
  loading: () => (
    <SkeletonGroup label="Loading metrics…" className="space-y-6">
      <div className="h-9" />
      {[0, 1, 2].map((i) => (
        <Card key={i} variant="inset" className="h-[315px] animate-pulse" />
      ))}
    </SkeletonGroup>
  ),
});
