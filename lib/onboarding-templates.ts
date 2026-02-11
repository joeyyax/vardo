import type { OnboardingCategory } from "@/lib/db/schema";

/**
 * Default onboarding checklist items created when a project enters the onboarding stage.
 * Items are ordered by category, then by position within category.
 */

export type OnboardingTemplateItem = {
  label: string;
  description: string;
  category: OnboardingCategory;
  isRequired: boolean;
  position: number;
};

export const DEFAULT_ONBOARDING_ITEMS: OnboardingTemplateItem[] = [
  {
    label: "Confirm project contacts",
    description:
      "Review and confirm who the key contacts are for this project.",
    category: "contacts",
    isRequired: true,
    position: 0,
  },
  {
    label: "Collect access and assets",
    description:
      "Gather any logins, credentials, brand files, or content needed to begin work.",
    category: "access",
    isRequired: false,
    position: 10,
  },
  {
    label: "Review scope and timeline",
    description:
      "Confirm the agreed scope, deliverables, and timeline before starting.",
    category: "review",
    isRequired: true,
    position: 90,
  },
];

/** Category labels for display */
export const ONBOARDING_CATEGORY_LABELS: Record<OnboardingCategory, string> = {
  contacts: "Contacts",
  access: "Access & Credentials",
  assets: "Assets & Content",
  hosting: "Hosting",
  review: "Final Review",
};
