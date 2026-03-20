import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user, projects, deployments, templates } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, sql } from "drizzle-orm";
import { AdminActions } from "./admin-actions";

export default async function AdminPage() {
  const session = await getSession();

  if (!session?.user?.id) {
    redirect("/login");
  }

  // Check admin status
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });

  if (!dbUser?.isAppAdmin) {
    redirect("/projects");
  }

  // Gather stats
  const [
    [{ userCount }],
    [{ projectCount }],
    [{ deploymentCount }],
    [{ templateCount }],
  ] = await Promise.all([
    db.select({ userCount: sql<number>`count(*)` }).from(user),
    db.select({ projectCount: sql<number>`count(*)` }).from(projects),
    db.select({ deploymentCount: sql<number>`count(*)` }).from(deployments),
    db.select({ templateCount: sql<number>`count(*)` }).from(templates),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          System administration and maintenance.
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Users", value: Number(userCount) },
          { label: "Projects", value: Number(projectCount) },
          { label: "Deployments", value: Number(deploymentCount) },
          { label: "Templates", value: Number(templateCount) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <AdminActions />
    </div>
  );
}
