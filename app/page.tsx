import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function Home() {
  const session = await getSession();

  if (session?.user) {
    redirect("/projects");
  }

  redirect("/login");
}
