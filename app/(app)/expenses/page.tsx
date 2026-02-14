import { redirect } from "next/navigation";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { ExpenseTimeline } from "@/components/expenses";
import { IntakeEmailPopover } from "@/components/projects/intake-email-popover";

type ExpensesPageProps = {
  searchParams: Promise<{ date?: string; expense?: string }>;
};

export default async function ExpensesPage({ searchParams }: ExpensesPageProps) {
  const [orgData, session] = await Promise.all([getCurrentOrg(), getSession()]);
  const { date, expense } = await searchParams;

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;

  // Check if expenses feature is enabled
  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  if (!features.expenses) {
    redirect("/track");
  }

  return (
    <div className="space-y-6">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Expenses</h1>
        <IntakeEmailPopover
          orgId={organization.id}
          intakeEmailToken={organization.intakeEmailToken ?? null}
        />
      </div>

      <ExpenseTimeline
        orgId={organization.id}
        currentUserId={session?.user?.id || ""}
        initialDate={date}
        highlightExpenseId={expense}
      />
    </div>
  );
}
