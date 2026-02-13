# Settings Reorganization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize settings into tabbed org settings + expanded profile page, and move settings access to org/user menus.

**Architecture:** Split the single settings page into 5 horizontal tabs (General, Workflow, Billing, Team, Integrations) using shadcn Tabs with URL search params. Move personal preferences and notification preferences to the existing `/profile` page. Remove Settings from sidebar nav and add settings links to the org switcher and user avatar menus.

**Tech Stack:** Next.js App Router, shadcn/ui Tabs, React, TypeScript

---

### Task 1: Create Settings Tabs Layout

**Files:**
- Create: `app/(app)/settings/settings-tabs.tsx`
- Modify: `app/(app)/settings/page.tsx`

**Step 1: Create the settings tabs client component**

Create `app/(app)/settings/settings-tabs.tsx`:

```tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ReactNode } from "react";

const SETTINGS_TABS = [
  { value: "general", label: "General" },
  { value: "workflow", label: "Workflow" },
  { value: "billing", label: "Billing" },
  { value: "team", label: "Team" },
  { value: "integrations", label: "Integrations" },
] as const;

type SettingsTabsProps = {
  generalContent: ReactNode;
  workflowContent: ReactNode;
  billingContent: ReactNode;
  teamContent: ReactNode;
  integrationsContent: ReactNode;
};

export function SettingsTabs({
  generalContent,
  workflowContent,
  billingContent,
  teamContent,
  integrationsContent,
}: SettingsTabsProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = searchParams.get("tab") || "general";

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "general") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const query = params.toString();
    router.replace(`/settings${query ? `?${query}` : ""}`, { scroll: false });
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        {SETTINGS_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="general" className="mt-6 space-y-8">
        {generalContent}
      </TabsContent>
      <TabsContent value="workflow" className="mt-6 space-y-8">
        {workflowContent}
      </TabsContent>
      <TabsContent value="billing" className="mt-6 space-y-8">
        {billingContent}
      </TabsContent>
      <TabsContent value="team" className="mt-6 space-y-8">
        {teamContent}
      </TabsContent>
      <TabsContent value="integrations" className="mt-6 space-y-8">
        {integrationsContent}
      </TabsContent>
    </Tabs>
  );
}
```

**Step 2: Rewrite settings page.tsx to use tabs**

Replace `app/(app)/settings/page.tsx` with:

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { SettingsForm } from "./settings-form";
import { FeaturesForm } from "./features-form";
import { PaymentSettings } from "./payment-settings";
import { ImportWizard } from "@/components/settings/import-wizard";
import { DangerZone } from "@/components/settings/danger-zone";
import { getStripeStatus } from "@/lib/payments/stripe";
import { TaskTypesSettings } from "./task-types-settings";
import { TaskTagsSettings } from "./task-tags-settings";
import { IntakeEmailSettings } from "./intake-email-settings";
import { SettingsTabs } from "./settings-tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";

export default async function SettingsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;
  const canEdit = membership.role === "owner" || membership.role === "admin";

  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  // --- General Tab ---
  const generalContent = (
    <>
      <SettingsForm
        organization={organization}
        canEdit={canEdit}
        features={features}
      />
      <FeaturesForm
        organizationId={organization.id}
        features={features}
        canEdit={canEdit}
      />
      {membership.role === "owner" && (
        <DangerZone orgId={organization.id} orgName={organization.name} />
      )}
    </>
  );

  // --- Workflow Tab ---
  const workflowContent = (
    <>
      {features.pm && (
        <>
          <TaskTypesSettings orgId={organization.id} />
          <TaskTagsSettings orgId={organization.id} />
        </>
      )}
      {features.proposals && (
        <Card className="max-w-2xl squircle">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Document Templates</CardTitle>
                <CardDescription>
                  Manage templates for proposals, contracts, and change orders.
                </CardDescription>
              </div>
              <Link href="/settings/templates">
                <Button variant="outline" className="squircle">
                  Manage Templates
                </Button>
              </Link>
            </div>
          </CardHeader>
        </Card>
      )}
      {!features.pm && !features.proposals && (
        <Card className="max-w-2xl squircle">
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Enable Project Management or Proposals in the General tab to configure workflow settings.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );

  // --- Billing Tab ---
  const billingContent = (
    <>
      {features.invoicing ? (
        <PaymentSettings
          organizationId={organization.id}
          stripeStatus={getStripeStatus()}
          canEdit={canEdit}
        />
      ) : (
        <Card className="max-w-2xl squircle">
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Enable Invoicing in the General tab to configure billing settings.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );

  // --- Team Tab ---
  const teamContent = (
    <Card className="max-w-2xl squircle">
      <CardHeader>
        <CardTitle>Team Members</CardTitle>
        <CardDescription>
          Manage your team members, roles, and invitations.
        </CardDescription>
      </CardHeader>
      <CardContent className="py-8 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Users className="size-5 text-muted-foreground" />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Team management is coming soon.
        </p>
      </CardContent>
    </Card>
  );

  // --- Integrations Tab ---
  const integrationsContent = (
    <>
      {features.expenses && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-medium">Expense Intake</h2>
            <p className="text-sm text-muted-foreground">
              Forward emails to capture invoices and receipts.
            </p>
          </div>
          <IntakeEmailSettings
            organizationId={organization.id}
            intakeEmailToken={organization.intakeEmailToken ?? null}
            canEdit={canEdit}
          />
        </div>
      )}
      {features.time_tracking && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-medium">Import</h2>
            <p className="text-sm text-muted-foreground">
              Import time entries from other services.
            </p>
          </div>
          <ImportWizard orgId={organization.id} />
        </div>
      )}
      {!features.expenses && !features.time_tracking && (
        <Card className="max-w-2xl squircle">
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No integrations are available for your current feature set.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your organization settings.
        </p>
      </div>

      <SettingsTabs
        generalContent={generalContent}
        workflowContent={workflowContent}
        billingContent={billingContent}
        teamContent={teamContent}
        integrationsContent={integrationsContent}
      />
    </div>
  );
}
```

**Step 3: Verify it compiles**

Run: `pnpm typecheck`
Expected: No errors in settings files

**Step 4: Commit**

```bash
git add app/(app)/settings/settings-tabs.tsx app/(app)/settings/page.tsx
git commit -m "feat: reorganize settings page into tabbed layout"
```

---

### Task 2: Move Personal Preferences & Notifications to Profile

**Files:**
- Modify: `app/(app)/profile/profile-content.tsx`
- No changes to: `app/(app)/settings/personal-preferences.tsx` (reuse as-is)
- No changes to: `app/(app)/settings/notification-preferences.tsx` (reuse as-is)

**Step 1: Add preferences and notifications to profile page**

Update `app/(app)/profile/profile-content.tsx` to import and render `PersonalPreferences` and `NotificationPreferences` after the existing Account card:

```tsx
// Add imports at top:
import { PersonalPreferences } from "@/app/(app)/settings/personal-preferences";
import { NotificationPreferences } from "@/app/(app)/settings/notification-preferences";

// In the JSX, after the Account card and before the Danger Zone card, add:
{/* Preferences */}
<PersonalPreferences />

{/* Notifications */}
<NotificationPreferences />
```

Note: `PersonalPreferences` currently has a `max-w-2xl` constraint which fits the profile layout. `NotificationPreferences` also has `max-w-2xl`. Both are self-contained client components that can be rendered anywhere.

**Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add app/(app)/profile/profile-content.tsx
git commit -m "feat: add personal preferences and notifications to profile page"
```

---

### Task 3: Remove Settings from Sidebar Nav

**Files:**
- Modify: `components/layout/sidebar-nav.tsx`

**Step 1: Remove the Settings nav item**

In `components/layout/sidebar-nav.tsx`, remove the Settings entry from the `navItems` array (lines 118-124):

```tsx
// DELETE this entry:
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Organization settings",
    // Always visible
  },
```

Also clean up the unused `Settings` import from lucide-react if it's no longer used elsewhere in the file.

**Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add components/layout/sidebar-nav.tsx
git commit -m "feat: remove settings from sidebar nav"
```

---

### Task 4: Add Settings Link to Org Switcher Menu

**Files:**
- Modify: `components/layout/org-switcher.tsx`

**Step 1: Add Settings menu item to org switcher dropdown**

In `components/layout/org-switcher.tsx`, add a Settings link after the org list and before "Create organization". Import `Settings` icon from lucide-react and `useRouter` is already imported.

After the org list map and `<DropdownMenuSeparator />` (line 177), add:

```tsx
<DropdownMenuItem
  className="gap-2 cursor-pointer"
  onClick={() => router.push("/settings")}
>
  <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
    <Settings className="size-3" />
  </div>
  <span>Settings</span>
</DropdownMenuItem>
<DropdownMenuSeparator />
```

Add `Settings` to the lucide-react import at the top of the file.

**Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add components/layout/org-switcher.tsx
git commit -m "feat: add settings link to org switcher menu"
```

---

### Task 5: Verify and Clean Up

**Files:**
- Review: `app/(app)/settings/page.tsx` (ensure no references to removed components)

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 2: Run lint**

Run: `pnpm lint`
Expected: No errors (or pre-existing only)

**Step 3: Manual smoke test checklist**

- [ ] `/settings` loads with General tab active by default
- [ ] Each tab shows the correct content
- [ ] `?tab=workflow` in URL selects Workflow tab
- [ ] Switching tabs updates URL search params
- [ ] `/profile` shows preferences and notifications below account section
- [ ] Org switcher dropdown shows Settings link
- [ ] Clicking Settings in org switcher navigates to `/settings`
- [ ] User avatar dropdown still shows Profile link
- [ ] Settings no longer appears in sidebar nav
- [ ] `/settings/templates` still works (back button links to `/settings`)

**Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: clean up settings reorganization"
```
