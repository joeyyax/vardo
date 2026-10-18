import { Suspense } from "react";
import { AppsView } from "./apps-view";

export default function AdminAppsPage() {
  return (
    <Suspense>
      <AppsView />
    </Suspense>
  );
}
