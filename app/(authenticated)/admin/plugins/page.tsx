import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { PluginManager } from "./plugin-manager";

export default async function AdminPluginsPage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });
  if (!dbUser?.isAppAdmin) redirect("/projects");

  return <PluginManager />;
}
