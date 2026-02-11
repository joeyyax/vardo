import { redirect } from "next/navigation"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getSession, getCurrentOrg } from "@/lib/auth/session"

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Check for session
  const session = await getSession()
  if (!session?.user) {
    redirect("/login")
  }

  // If user already has an org, redirect to track
  const orgData = await getCurrentOrg()
  if (orgData) {
    redirect("/track")
  }

  // Minimal layout for onboarding
  return (
    <TooltipProvider>
      <div className="min-h-dvh bg-background">
        {children}
      </div>
    </TooltipProvider>
  )
}
