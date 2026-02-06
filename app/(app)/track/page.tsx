import { redirect } from "next/navigation"
import { getCurrentOrg } from "@/lib/auth/session"
import { Timeline } from "@/components/timeline"

type TrackPageProps = {
  searchParams: Promise<{ date?: string; entry?: string }>
}

export default async function TrackPage({ searchParams }: TrackPageProps) {
  const orgData = await getCurrentOrg()
  const { date, entry } = await searchParams

  if (!orgData) {
    redirect("/onboarding")
  }

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Track</h1>
      </div>

      <Timeline
        orgId={orgData.organization.id}
        initialDate={date}
        highlightEntryId={entry}
      />
    </div>
  )
}
