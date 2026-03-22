import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/setup";
import { SetupWizard } from "./setup-wizard";

export default async function SetupPage() {
  if (!(await needsSetup())) {
    redirect("/");
  }

  return <SetupWizard />;
}
