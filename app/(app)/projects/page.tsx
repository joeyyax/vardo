import { redirect } from "next/navigation"
import { getCurrentOrg } from "@/lib/auth/session"

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg()

  if (!orgData) {
    redirect("/onboarding")
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-muted-foreground">
          Manage your projects and tasks.
        </p>
      </div>

      {/* Placeholder content - will be replaced in Phase 2.3 */}
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Project management coming soon.
        </p>
      </div>
    </div>
  )
}
