import type { DeployView } from "@/lib/ui/deploy-wait";

/** A row's deploy label: the place in line on a phone, with the estimate from `sm` up. */
export function RowDeployLabel({ view }: { view: DeployView }) {
  if (view.short === view.label) return <>{view.label}</>;
  return (
    <>
      <span className="sm:hidden">{view.short}</span>
      <span className="max-sm:hidden">{view.label}</span>
    </>
  );
}
