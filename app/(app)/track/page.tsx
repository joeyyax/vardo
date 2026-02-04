import { redirect } from "next/navigation"
import { getCurrentOrg } from "@/lib/auth/session"
import { Timeline } from "@/components/timeline"

export default async function TrackPage() {
  const orgData = await getCurrentOrg()

  if (!orgData) {
    redirect("/onboarding")
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Track</h1>
        <p className="text-muted-foreground">
          View and manage your time entries.
        </p>
      </div>

      <Timeline orgId={orgData.organization.id} />
    </div>
  )
}
