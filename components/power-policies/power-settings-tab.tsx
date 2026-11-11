import { UpsSettings } from "@/components/power/ups-settings";
import { PowerPolicySettings } from "./power-policy-settings";

/** The UPS servers tab: the UPSes, then what Vardo does on battery. */
export function PowerSettingsTab() {
  return (
    <div className="space-y-12">
      <UpsSettings />
      <PowerPolicySettings />
    </div>
  );
}
