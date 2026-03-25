import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/setup";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { getProviderRestrictions } from "@/lib/config/provider-restrictions";
import { SetupWizard } from "./setup-wizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await needsSetup())) {
    redirect("/");
  }

  const meshEnabled = await isFeatureEnabledAsync("mesh");
  const providerRestrictions = getProviderRestrictions();

  return (
    <SetupWizard
      meshEnabled={meshEnabled}
      providerRestrictions={providerRestrictions}
    />
  );
}
