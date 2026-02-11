/**
 * Offboarding migration checklist content and migration assistance tier definitions.
 * The migration checklist is informational (read-only guide), not interactive checkboxes.
 */

export type MigrationPhase = {
  id: string;
  title: string;
  description: string;
  items: string[];
};

export const MIGRATION_CHECKLIST_PHASES: MigrationPhase[] = [
  {
    id: "planning",
    title: "Planning",
    description: "Define your migration timeline and identify what needs to move.",
    items: [
      "Decide on a target migration date",
      "Identify which assets you need (code, database, media files)",
      "Choose your new hosting provider or environment",
      "Determine if you need migration assistance or will self-serve",
    ],
  },
  {
    id: "access_accounts",
    title: "Access & Accounts",
    description: "Ensure you have all credentials and access needed for the transition.",
    items: [
      "Confirm you have domain registrar access",
      "Verify DNS management credentials",
      "Check that you have admin access to any third-party services",
      "Document any API keys or integrations that need to be reconfigured",
    ],
  },
  {
    id: "data_export",
    title: "Data Export",
    description: "Request and download your application data.",
    items: [
      "Request your application data export (use the button above)",
      "Download exported files when ready",
      "Verify the export includes everything you need",
      "Store a backup copy in a safe location",
    ],
  },
  {
    id: "environment_prep",
    title: "New Environment Preparation",
    description: "Set up your new hosting environment before migration.",
    items: [
      "Provision your new server or hosting account",
      "Install required software and dependencies",
      "Configure environment variables and secrets",
      "Set up database and any required services",
    ],
  },
  {
    id: "deployment",
    title: "Deployment",
    description: "Deploy your application to the new environment.",
    items: [
      "Upload application code to new environment",
      "Import database backup",
      "Upload media files and assets",
      "Configure any necessary redirects",
    ],
  },
  {
    id: "validation",
    title: "Validation",
    description: "Test everything works correctly in the new environment.",
    items: [
      "Test all core functionality",
      "Verify database content and integrity",
      "Check that media files load correctly",
      "Test any forms, integrations, or dynamic features",
    ],
  },
  {
    id: "cutover",
    title: "Cutover",
    description: "Switch DNS and finalize the transition.",
    items: [
      "Update DNS records to point to new environment",
      "Allow time for DNS propagation (up to 48 hours)",
      "Verify the site loads correctly via the domain",
      "Test SSL certificates are working",
    ],
  },
  {
    id: "decommissioning",
    title: "Decommissioning",
    description: "Clean up the old environment once everything is confirmed working.",
    items: [
      "Confirm everything works on the new environment for at least a few days",
      "Remove or archive old hosting resources",
      "Update any external references or bookmarks",
      "Notify stakeholders that the migration is complete",
    ],
  },
];

export type MigrationAssistanceTier = {
  id: string;
  name: string;
  description: string;
  included: string[];
  notIncluded: string[];
  pricing: string;
};

export const MIGRATION_ASSISTANCE_TIERS: MigrationAssistanceTier[] = [
  {
    id: "self_service",
    name: "Self-Service",
    description:
      "Handle the migration on your own with automated data exports and this checklist as your guide.",
    included: [
      "Automated data export (code, database, media)",
      "Migration checklist",
      "Standard documentation",
    ],
    notIncluded: [
      "Direct support or guidance",
      "Hands-on deployment assistance",
      "Validation or troubleshooting",
    ],
    pricing: "Included",
  },
  {
    id: "guided",
    name: "Guided Migration",
    description:
      "Get answers to your questions and guidance through the migration process, billed at standard hourly rates.",
    included: [
      "Everything in Self-Service",
      "Q&A about exported data and structure",
      "Explaining deployment and configuration details",
      "Coordinating final export timing",
    ],
    notIncluded: [
      "Hands-on deployment or debugging",
      "Rebuilding or re-architecting",
      "Ongoing support after migration",
    ],
    pricing: "Billed at standard hourly rates",
  },
  {
    id: "hands_on",
    name: "Hands-On Migration",
    description:
      "Limited hands-on assistance with deployment to your new environment. Requires a written agreement.",
    included: [
      "Everything in Guided Migration",
      "Assisting with deployment to new environment",
      "Coordinating cutover timing",
      "Limited validation after migration",
    ],
    notIncluded: [
      "Rebuilding or re-architecting the application",
      "Ongoing support or maintenance",
      "Guaranteeing compatibility with new environment",
    ],
    pricing: "Requires written agreement — scoped and billed separately",
  },
];

/** What's included in a data export */
export const DATA_EXPORT_CONTENTS = {
  included: [
    "Application source code",
    "Database backup",
    "Media files and uploads",
  ],
  excluded: [
    "Billing and payment records",
    "Internal project notes",
    "Client management data",
  ],
};
