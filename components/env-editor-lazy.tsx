"use client";

import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { SkeletonGroup } from "@/components/ui/skeleton";

/** CodeMirror loads on first render of the editor, not with the page. */
export const EnvEditor = dynamic(() => import("./env-editor").then((m) => m.EnvEditor), {
  ssr: false,
  loading: () => (
    <SkeletonGroup label="Loading editor…">
      <Card variant="inset" className="h-[450px] animate-pulse" />
    </SkeletonGroup>
  ),
});
