import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/setup";
import { SetupWizard } from "./setup-wizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await needsSetup())) {
    redirect("/");
  }

  return <SetupWizard />;
}
