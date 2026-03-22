import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { needsSetup } from "@/lib/setup";

export default async function Home() {
  if (await needsSetup()) {
    redirect("/setup");
  }

  const session = await getSession();

  if (session?.user) {
    redirect("/projects");
  }

  redirect("/login");
}
