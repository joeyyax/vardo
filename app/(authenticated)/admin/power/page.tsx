import { UpsStatus } from "@/components/power/ups-status";
import { PowerActions } from "@/components/power-policies/power-actions";

export default function AdminPowerPage() {
  return (
    <div className="space-y-10">
      <UpsStatus />
      <PowerActions />
    </div>
  );
}
