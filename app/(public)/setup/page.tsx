import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/setup";
import { SetupWizard } from "./setup-wizard";
import { readMarker } from "@/lib/restore/marker";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if ((await readMarker())?.phase === "database") redirect("/setup/restore");
  if (!(await needsSetup())) {
    redirect("/");
  }

  return <SetupWizard />;
}
