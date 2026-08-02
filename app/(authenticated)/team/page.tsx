import { notFound, redirect } from "next/navigation";
import { isFeatureEnabledAsync } from "@/lib/config/features";

export default async function TeamPage() {
  if (!(await isFeatureEnabledAsync("teams"))) notFound();

  redirect("/settings/team");
}
