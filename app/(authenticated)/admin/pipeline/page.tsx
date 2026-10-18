import { Suspense } from "react";
import { PipelineView } from "./pipeline-view";

export default function AdminPipelinePage() {
  return (
    <Suspense>
      <PipelineView />
    </Suspense>
  );
}
