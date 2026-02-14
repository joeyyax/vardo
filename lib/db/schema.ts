import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  uuid,
  date,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Feature flags type for organizations
export type OrgFeatures = {
  time_tracking: boolean;
  invoicing: boolean;
  expenses: boolean;
  pm: boolean;
  proposals: boolean;
  defaultAssignee?: string | null;
  secondMemberNudge?: boolean;
};

// Default features for new organizations (backward compatible)
export const DEFAULT_ORG_FEATURES: OrgFeatures = {
  time_tracking: true,
  invoicing: true,
  expenses: true,
  pm: false,
  proposals: false,
  defaultAssignee: null,
  secondMemberNudge: false,
};

// Organizations (tenants)
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  defaultRate: integer("default_rate"), // cents per hour
  roundingIncrement: integer("rounding_increment").default(15), // minutes
  plan: text("plan").default("free"),
  limits: jsonb("limits"),
  // Feature flags - controls which modules are enabled
  features: jsonb("features").$type<OrgFeatures>().default(DEFAULT_ORG_FEATURES),
  // Billing defaults
  defaultBillingType: text("default_billing_type").default("hourly"), // 'hourly' | 'retainer_fixed' | 'retainer_capped' | 'retainer_uncapped' | 'fixed_project'
  defaultBillingFrequency: text("default_billing_frequency"), // 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'per_project'
  defaultPaymentTermsDays: integer("default_payment_terms_days").default(30),
  // Payment provider integration
  paymentProvider: text("payment_provider"), // 'stripe' | 'paypal' | 'square' | null
  paymentConfig: jsonb("payment_config"), // Encrypted API keys or OAuth tokens
  // Toggl integration
  togglApiToken: text("toggl_api_token"),
  togglWorkspaceId: text("toggl_workspace_id"),
  togglLastImportAt: timestamp("toggl_last_import_at"),
  // Email intake
  intakeEmailToken: text("intake_email_token").unique(),
  // Team join link
  joinToken: text("join_token").unique(),
  joinEnabled: boolean("join_enabled").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// =============================================================================
// Better Auth Tables
// These tables are required by Better Auth for authentication
// =============================================================================

// Users table (Better Auth "user" table)
// This serves as both the Better Auth user table and our app's user table
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Two-factor authentication status (added by twoFactor plugin)
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  // App-level admin (first user to sign up becomes admin)
  isAppAdmin: boolean("is_app_admin").default(false),
});

// Sessions table (Better Auth)
export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

// Accounts table (Better Auth - for OAuth providers and password auth)
export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)]
);

// Verification table (Better Auth - for email verification, password reset, magic links)
export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

// Passkeys table (Better Auth - for WebAuthn/passkey authentication)
export const passkeys = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at").defaultNow(),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("passkey_user_id_idx").on(table.userId),
    index("passkey_credential_id_idx").on(table.credentialID),
  ]
);

// Two-factor authentication table (Better Auth - stores TOTP secrets and backup codes)
export const twoFactors = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("two_factor_secret_idx").on(table.secret),
    index("two_factor_user_id_idx").on(table.userId),
  ]
);

// =============================================================================
// Application Tables
// =============================================================================

// Organization memberships
export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // owner, admin, member
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Team invitations (for inviting users to join an organization)
export const teamInvitations = pgTable("team_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"), // admin, member
  invitedBy: text("invited_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, accepted, expired
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

// Project members (controls which projects a member can access)
// Admins and owners bypass this — they have implicit access to all projects
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_members_project_user_idx").on(
      table.projectId,
      table.userId
    ),
  ]
);

// Clients
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  parentClientId: uuid("parent_client_id"), // Optional parent for hierarchy (e.g., Agency → End Client)
  name: text("name").notNull(),
  color: text("color"), // for UI display
  contactEmail: text("contact_email"), // primary contact email for sending documents
  rateOverride: integer("rate_override"), // cents per hour, null = inherit
  isBillable: boolean("is_billable"), // null = inherit from org
  // Billing configuration
  billingType: text("billing_type"), // 'hourly' | 'retainer_fixed' | 'retainer_capped' | 'retainer_uncapped' | 'fixed_project'
  billingFrequency: text("billing_frequency"), // 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'per_project'
  autoGenerateInvoices: boolean("auto_generate_invoices").default(false),
  retainerAmount: integer("retainer_amount"), // cents
  includedMinutes: integer("included_minutes"), // monthly included hours (stored as minutes)
  overageRate: integer("overage_rate"), // cents per hour for overage beyond included hours
  billingDayOfWeek: integer("billing_day_of_week"), // 0-6 for weekly/biweekly (0=Sunday)
  billingDayOfMonth: integer("billing_day_of_month"), // 1-31 for monthly/quarterly
  paymentTermsDays: integer("payment_terms_days"), // Net X days, null = inherit from org
  lastInvoicedDate: date("last_invoiced_date"),
  // Email intake
  intakeEmailToken: text("intake_email_token").unique(),
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Client comments (discussion on clients)
export const clientComments = pgTable("client_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false), // false = internal, true = client-visible
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Client watchers
export const clientWatchers = pgTable(
  "client_watchers",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"), // 'creator', 'commenter', 'manual'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.clientId, t.userId] }),
  })
);

// Invitation roles for client portal
export const INVITATION_ROLES = ["viewer", "contributor"] as const;
export type InvitationRole = (typeof INVITATION_ROLES)[number];

// Visibility settings type for invitations
export type InvitationVisibility = {
  show_rates: boolean;
  show_time: boolean;
  show_costs: boolean;
};

export const DEFAULT_INVITATION_VISIBILITY: InvitationVisibility = {
  show_rates: false,
  show_time: true,
  show_costs: false,
};

// Client invitations for client portal access (trickles down to all projects)
export const clientInvitations = pgTable(
  "client_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => clientContacts.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    role: text("role").$type<InvitationRole>().notNull().default("viewer"),
    visibility: jsonb("visibility").$type<InvitationVisibility>().default(DEFAULT_INVITATION_VISIBILITY),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    token: text("token").notNull().unique(),
    sentAt: timestamp("sent_at"),
    viewedAt: timestamp("viewed_at"),
    acceptedAt: timestamp("accepted_at"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("client_invitations_client_id_idx").on(table.clientId),
    index("client_invitations_email_idx").on(table.email),
    index("client_invitations_token_idx").on(table.token),
  ]
);

// Client contacts
export const CONTACT_TYPES = ["primary", "billing", "other"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const clientContacts = pgTable(
  "client_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    type: text("type").$type<ContactType>().notNull().default("other"),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("client_contacts_client_id_idx").on(table.clientId)]
);

// Contact comments (discussion on contacts)
export const contactComments = pgTable("contact_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => clientContacts.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false),
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Contact watchers
export const contactWatchers = pgTable(
  "contact_watchers",
  {
    contactId: uuid("contact_id")
      .notNull()
      .references(() => clientContacts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"), // 'creator', 'commenter', 'manual'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.contactId, t.userId] }),
  })
);

// Project-level contact overrides (junction: project ↔ client contact)
export const projectContacts = pgTable(
  "project_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => clientContacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_contacts_project_contact_idx").on(table.projectId, table.contactId),
    index("project_contacts_project_id_idx").on(table.projectId),
    index("project_contacts_contact_id_idx").on(table.contactId),
  ]
);

// Retainer periods — tracks monthly retainer consumption and rollover
export type RetainerPeriodStatus = "active" | "closed";
export const retainerPeriods = pgTable("retainer_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  includedMinutes: integer("included_minutes").notNull(), // snapshot of client's included hours at period creation
  usedMinutes: integer("used_minutes").notNull().default(0),
  rolloverMinutes: integer("rollover_minutes").notNull().default(0), // unused minutes from previous period (max 1 period rollover)
  invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  status: text("status").$type<RetainerPeriodStatus>().notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Project stages — 8-stage lifecycle
export const PROJECT_STAGES = [
  "getting_started",
  "proposal",
  "agreement",
  "onboarding",
  "active",
  "ongoing",
  "offboarding",
  "completed",
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

// Valid stage transitions — any stage can move to any other stage.
// Forward transitions are the natural flow; backward transitions let users
// revisit earlier stages when needed.
export const VALID_STAGE_TRANSITIONS: Record<ProjectStage, readonly ProjectStage[]> = {
  getting_started: ["proposal", "agreement", "onboarding", "active", "ongoing", "offboarding", "completed"],
  proposal: ["getting_started", "agreement", "onboarding", "active", "ongoing", "offboarding", "completed"],
  agreement: ["getting_started", "proposal", "onboarding", "active", "ongoing", "offboarding", "completed"],
  onboarding: ["getting_started", "proposal", "agreement", "active", "ongoing", "offboarding", "completed"],
  active: ["getting_started", "proposal", "agreement", "onboarding", "ongoing", "offboarding", "completed"],
  ongoing: ["getting_started", "proposal", "agreement", "onboarding", "active", "offboarding", "completed"],
  offboarding: ["getting_started", "proposal", "agreement", "onboarding", "active", "ongoing", "completed"],
  completed: ["getting_started", "proposal", "agreement", "onboarding", "active", "ongoing", "offboarding"],
} as const;

// Forward-only transitions — the natural lifecycle progression.
// Used by auto-advancement logic in StageGuidance.
export const FORWARD_STAGE_TRANSITIONS: Record<ProjectStage, readonly ProjectStage[]> = {
  getting_started: ["proposal"],
  proposal: ["agreement"],
  agreement: ["onboarding"],
  onboarding: ["active"],
  active: ["ongoing", "offboarding"],
  ongoing: ["offboarding"],
  offboarding: ["completed"],
  completed: [],
} as const;

// Budget types
export const BUDGET_TYPES = ["hours", "fixed"] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

// Projects
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"), // optional project code
  rateOverride: integer("rate_override"),
  isBillable: boolean("is_billable"),
  isArchived: boolean("is_archived").default(false),
  // Project lifecycle stage
  stage: text("stage").$type<ProjectStage>().default("getting_started"),
  // Budget tracking
  budgetType: text("budget_type").$type<BudgetType>(), // 'hours' | 'fixed' | null
  budgetHours: integer("budget_hours"), // total hours budget
  budgetAmountCents: integer("budget_amount_cents"), // fixed price budget in cents
  // Email intake
  intakeEmailToken: text("intake_email_token").unique(),
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Onboarding checklist items
export const ONBOARDING_CATEGORIES = ["contacts", "access", "assets", "hosting", "review"] as const;
export type OnboardingCategory = (typeof ONBOARDING_CATEGORIES)[number];

export const onboardingItems = pgTable("onboarding_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  description: text("description"),
  category: text("category").$type<OnboardingCategory>().notNull(),
  isRequired: boolean("is_required").default(true).notNull(),
  isCompleted: boolean("is_completed").default(false).notNull(),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by").references(() => users.id, { onDelete: "set null" }),
  position: integer("position").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Data export requests (offboarding)
export const DATA_EXPORT_STATUSES = ["requested", "processing", "ready", "expired"] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

export const dataExportRequests = pgTable("data_export_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
  status: text("status").$type<DataExportStatus>().notNull().default("requested"),
  includes: jsonb("includes").$type<{ code: boolean; database: boolean; media: boolean }>(),
  notes: text("notes"),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

// Task statuses for PM feature
// null = category-only task (for time tracking), other values = work item
export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// Task relationship types
export const TASK_RELATIONSHIP_TYPES = ["blocked_by", "related_to"] as const;
export type TaskRelationshipType = (typeof TASK_RELATIONSHIP_TYPES)[number];

// Task types - org-defined (Bug, Feature, Task, etc.)
export const taskTypes = pgTable("task_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  icon: text("icon"),
  defaultFields: jsonb("default_fields"), // { "severity": true, "steps_to_reproduce": true }
  position: integer("position").default(0),
  isArchived: boolean("is_archived").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task tags - org-defined with hybrid creation
export const taskTags = pgTable("task_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  isPredefined: boolean("is_predefined").default(true), // false = created ad-hoc
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Tasks - unified model for both time tracking categories and PM work items
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  rateOverride: integer("rate_override"),
  isBillable: boolean("is_billable"),
  isArchived: boolean("is_archived").default(false),
  // PM fields
  status: text("status").$type<TaskStatus>(),
  isRecurring: boolean("is_recurring").default(false),
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  position: integer("position").default(0),
  priority: text("priority").$type<TaskPriority>(),
  // Expanded task fields
  typeId: uuid("type_id").references(() => taskTypes.id, { onDelete: "set null" }),
  estimateMinutes: integer("estimate_minutes"),
  prLink: text("pr_link"),
  isClientVisible: boolean("is_client_visible").default(true),
  dueDate: date("due_date"),
  metadata: jsonb("metadata").default({}), // Type-specific fields (severity, steps_to_reproduce, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Task tag assignments (many-to-many)
export const taskTagAssignments = pgTable("task_tag_assignments", {
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id")
    .notNull()
    .references(() => taskTags.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task relationships (blocked_by, related_to)
export const taskRelationships = pgTable("task_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceTaskId: uuid("source_task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  targetTaskId: uuid("target_task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  type: text("type").$type<TaskRelationshipType>().notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task files (links to project_files)
export const taskFiles = pgTable("task_files", {
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  fileId: uuid("file_id")
    .notNull()
    .references(() => projectFiles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task comments (internal by default)
export const taskComments = pgTable("task_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false), // false = internal, true = client-visible
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Task watchers
export const taskWatchers = pgTable("task_watchers", {
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason"), // 'creator', 'assignee', 'commenter', 'manual'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Project comments (discussion on projects)
export const projectComments = pgTable("project_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false), // false = internal, true = client-visible
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Project watchers
export const projectWatchers = pgTable(
  "project_watchers",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"), // 'creator', 'commenter', 'manual'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.userId] }),
  })
);

// Time entries
// Entries can be assigned at any level: client only, client+project, or client+project+task
export const timeEntries = pgTable("time_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // At minimum, clientId is required. projectId and taskId are optional.
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  description: text("description"),
  date: date("date").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  isBillableOverride: boolean("is_billable_override"), // null = inherit
  // Link to recurring template if created from one
  recurringTemplateId: uuid("recurring_template_id").references(
    () => recurringTemplates.id,
    { onDelete: "set null" }
  ),
  // Tags extracted from description (e.g., #meeting #planning)
  tags: text("tags").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Report configs
export const reportConfigs = pgTable("report_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").references(() => clients.id, {
    onDelete: "cascade",
  }),
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  slug: text("slug").notNull().unique(),
  enabled: boolean("enabled").default(true),
  showRates: boolean("show_rates").default(false),
  autoSend: boolean("auto_send").default(false),
  autoSendDay: integer("auto_send_day"), // 0-6, Sunday = 0
  autoSendHour: integer("auto_send_hour"), // 0-23
  recipients: jsonb("recipients").$type<string[]>().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Saved report presets (user-saved filter configurations)
export const savedReportPresets = pgTable("saved_report_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tab: text("tab").notNull(), // 'overview' | 'accounting' | 'client-reports'
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Invoices
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    invoiceNumber: text("invoice_number").notNull(), // "INV-2024-001"
    status: text("status").default("draft"), // draft, sent, viewed, paid, voided
    isAutoGenerated: boolean("is_auto_generated").default(false), // true for rolling drafts
    dueDate: date("due_date"), // when payment is due
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    subtotal: integer("subtotal").notNull(), // cents
    totalMinutes: integer("total_minutes").notNull(),
    publicToken: text("public_token").notNull().unique(), // for public view
    notes: text("notes"), // additional notes for the invoice
    includeTimesheet: boolean("include_timesheet").default(false), // include detailed timesheet
    sentAt: timestamp("sent_at"),
    viewedAt: timestamp("viewed_at"),
    paidAt: timestamp("paid_at"),
    voidedAt: timestamp("voided_at"),
    // Stripe payment fields
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    paymentMethod: text("payment_method"), // 'card', 'us_bank_account', etc.
    paymentUrl: text("payment_url"), // Stripe Checkout URL for client payment
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("invoices_organization_id_idx").on(table.organizationId),
    index("invoices_client_id_idx").on(table.clientId),
    index("invoices_public_token_idx").on(table.publicToken),
  ]
);

// Invoice line items (snapshots of project/task data at time of invoice)
export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"), // reference only, data is snapshotted
    projectName: text("project_name").notNull(), // snapshot
    taskId: uuid("task_id"), // reference only, data is snapshotted
    taskName: text("task_name"), // snapshot
    description: text("description"), // AI-generated summary
    minutes: integer("minutes").notNull(),
    rate: integer("rate").notNull(), // cents/hour snapshot
    amount: integer("amount").notNull(), // cents
    entryIds: jsonb("entry_ids").$type<string[]>().default([]),
  },
  (table) => [index("invoice_line_items_invoice_id_idx").on(table.invoiceId)]
);

// Invoice comments (discussion on invoices)
export const invoiceComments = pgTable("invoice_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false),
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Invoice watchers (users subscribed to invoice updates)
export const invoiceWatchers = pgTable(
  "invoice_watchers",
  {
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"), // 'creator', 'commenter', 'manual'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.invoiceId, t.userId] }),
  })
);

// Import sessions (for resumable imports)
export const importSessions = pgTable("import_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(), // 'toggl_csv', 'toggl_api', etc.
  status: text("status").notNull().default("in_progress"), // 'in_progress', 'completed', 'cancelled'
  currentStep: text("current_step").notNull(), // 'columns', 'clients', 'projects', 'review', 'importing'
  // Store the raw data and mappings as JSON
  rawData: text("raw_data"), // CSV content or API response
  columnMapping: jsonb("column_mapping").$type<Record<string, string>>(),
  clientMappings: jsonb("client_mappings").$type<Array<{
    sourceName: string;
    targetId: string | null; // null = create new
    targetName: string;
    confidence: number; // 0-1
    confirmed: boolean;
  }>>(),
  projectMappings: jsonb("project_mappings").$type<Array<{
    sourceName: string;
    sourceCode: string | null;
    clientName: string;
    confirmed: boolean;
    // Optional fields from Toggl workspace export
    startDate?: string | null;
    estimateHours?: number | null;
    rate?: number | null;
    color?: string | null;
    billable?: boolean;
    actualHours?: number | null;
    isArchived?: boolean;
    togglId?: number;
  }>>(),
  // Progress tracking
  totalRows: integer("total_rows"),
  processedRows: integer("processed_rows").default(0),
  result: jsonb("result").$type<{
    clientsCreated: number;
    projectsCreated: number;
    tasksCreated: number;
    entriesImported: number;
    entriesSkipped: number;
    errors: string[];
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Recurring time entry templates
export const recurringTemplates = pgTable("recurring_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Entry details (same as time entry)
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull(),
  isBillableOverride: boolean("is_billable_override"),
  // Recurrence settings
  frequency: text("frequency").notNull(), // 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
  dayOfWeek: integer("day_of_week"), // 0-6 (Sunday-Saturday) for weekly/biweekly
  dayOfMonth: integer("day_of_month"), // 1-31 for monthly/quarterly
  // Status
  isPaused: boolean("is_paused").default(false),
  skippedDates: jsonb("skipped_dates").$type<string[]>().default([]),
  startDate: date("start_date").notNull(), // When to start showing
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Project invitations for client portal access
export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => clientContacts.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    role: text("role").$type<InvitationRole>().notNull().default("viewer"),
    visibility: jsonb("visibility").$type<InvitationVisibility>().default(DEFAULT_INVITATION_VISIBILITY),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    // Invitation token for accepting
    token: text("token").notNull().unique(),
    // Status tracking
    sentAt: timestamp("sent_at"),
    viewedAt: timestamp("viewed_at"),
    acceptedAt: timestamp("accepted_at"),
    // Links to user once accepted
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_invitations_project_id_idx").on(table.projectId),
    index("project_invitations_email_idx").on(table.email),
    index("project_invitations_token_idx").on(table.token),
  ]
);

// Project files (R2 storage)
export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // Original filename
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type").notNull(),
    r2Key: text("r2_key").notNull(), // Path in R2: /{org_id}/{project_id}/{file_id}/{filename}
    tags: jsonb("tags").$type<string[]>().default([]),
    // Portal visibility - if true, clients can see this file
    isPublic: boolean("is_public").default(false),
    // File superseding — points to the file this one replaces
    replacesId: uuid("replaces_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_files_project_id_idx").on(table.projectId),
    index("project_files_uploaded_by_idx").on(table.uploadedBy),
    index("project_files_replaces_id_idx").on(table.replacesId),
  ]
);

// Activity types for project activity log
export const ACTIVITY_TYPES = [
  "note",
  "stage_change",
  "task_created",
  "task_status_changed",
  "task_completed",
  "file_uploaded",
  "file_deleted",
  "invitation_sent",
  "invitation_accepted",
  "invoice_created",
  "invoice_sent",
  "document_sent",
  "document_accepted",
  "document_declined",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// Actor types for activity log
export const ACTOR_TYPES = ["user", "client", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// Activity metadata types
export type ActivityMetadata = {
  // Stage changes
  fromStage?: string;
  toStage?: string;
  // Task changes
  taskId?: string;
  taskName?: string;
  fromStatus?: string;
  toStatus?: string;
  // File events
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  // Invitation events
  invitationId?: string;
  inviteeEmail?: string;
  inviteeRole?: string;
  // Invoice events
  invoiceId?: string;
  invoiceNumber?: string;
  // Document events
  documentId?: string;
  documentTitle?: string;
  documentType?: string;
  // Generic
  [key: string]: unknown;
};

// Project activity log
export const projectActivities = pgTable(
  "project_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<ActivityType>().notNull(),
    // Who performed the action
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").$type<ActorType>().default("user"),
    // Content for notes
    content: text("content"),
    // Structured data for different event types
    metadata: jsonb("metadata").$type<ActivityMetadata>().default({}),
    // Visibility
    isPublic: boolean("is_public").default(false), // If true, visible to clients in portal
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_activities_project_id_idx").on(table.projectId),
    index("project_activities_type_idx").on(table.type),
    index("project_activities_created_at_idx").on(table.createdAt),
  ]
);

// Document types for proposals, contracts, and change orders
export const DOCUMENT_TYPES = ["proposal", "contract", "change_order", "orientation", "addendum"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// Document statuses
export const DOCUMENT_STATUSES = ["draft", "sent", "viewed", "accepted", "declined"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

// Expense statuses
export const EXPENSE_STATUSES = ["paid", "unpaid"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// Re-export document content types from template engine
export type {
  DocumentContent,
  RenderedSection,
  TemplateSection as TemplateSectionDef,
  TemplateVariable as TemplateVariableDef,
  TemplatePricingConfig,
} from "@/lib/template-engine/types";

// Import types for jsonb column typing
import type {
  DocumentContent,
  TemplateSection as TemplateSectionDef,
  TemplateVariable as TemplateVariableDef,
  TemplatePricingConfig,
} from "@/lib/template-engine/types";

// Document templates — org-scoped, user-configurable document structures
export const documentTemplates = pgTable(
  "document_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentType: text("document_type").$type<DocumentType>().notNull(),
    name: text("name").notNull(),
    displayLabel: text("display_label"), // overrides generic type label in UI
    description: text("description"),
    category: text("category"), // free-form grouping (e.g. "hourly", "retainer")
    sections: jsonb("sections").$type<TemplateSectionDef[]>().notNull().default([]),
    variableSchema: jsonb("variable_schema").$type<TemplateVariableDef[]>().notNull().default([]),
    pricingConfig: jsonb("pricing_config").$type<TemplatePricingConfig>(),
    sortOrder: integer("sort_order").default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_templates_org_idx").on(table.organizationId),
    index("document_templates_org_type_idx").on(table.organizationId, table.documentType),
  ]
);

// Documents (proposals and contracts)
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<DocumentType>().notNull(),
    status: text("status").$type<DocumentStatus>().notNull().default("draft"),
    title: text("title").notNull(),
    // Structured content with sections
    content: jsonb("content").$type<DocumentContent>().notNull().default({ sections: [] }),
    // Template reference (audit trail -- documents are frozen snapshots)
    templateId: uuid("template_id").references(() => documentTemplates.id, { onDelete: "set null" }),
    variableValues: jsonb("variable_values").$type<Record<string, string>>(),
    // For proposals - whether accepting requires signing a contract
    requiresContract: boolean("requires_contract").default(false),
    // Public access token for client viewing/accepting
    publicToken: text("public_token").unique(),
    // Tracking timestamps
    sentAt: timestamp("sent_at"),
    viewedAt: timestamp("viewed_at"),
    acceptedAt: timestamp("accepted_at"),
    declinedAt: timestamp("declined_at"),
    // Who accepted/declined (email address)
    acceptedBy: text("accepted_by"),
    declinedBy: text("declined_by"),
    declineReason: text("decline_reason"),
    // Document locking
    lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
    lockedAt: timestamp("locked_at"),
    lastActiveAt: timestamp("last_active_at"),
    // Created by
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("documents_organization_id_idx").on(table.organizationId),
    index("documents_project_id_idx").on(table.projectId),
    index("documents_public_token_idx").on(table.publicToken),
    index("documents_status_idx").on(table.status),
  ]
);

// Document revision reasons
export const REVISION_REASONS = ["manual", "lock_transfer", "auto_save"] as const;
export type RevisionReason = (typeof REVISION_REASONS)[number];

// Document revisions (snapshots saved before lock transfers, manual saves, etc.)
export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    content: jsonb("content").$type<DocumentContent>(),
    variableValues: jsonb("variable_values").$type<Record<string, string>>(),
    title: text("title"),
    savedBy: text("saved_by").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").$type<RevisionReason>().notNull().default("manual"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_revisions_document_id_idx").on(table.documentId, table.createdAt),
  ]
);

// Document comments (discussion on proposals/contracts)
export const documentComments = pgTable("document_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false),
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Document watchers (users subscribed to document updates)
export const documentWatchers = pgTable(
  "document_watchers",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"), // 'creator', 'commenter', 'manual'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.userId] }),
  })
);

// Expenses for cost tracking (project-specific or general business overhead)
export const projectExpenses = pgTable(
  "project_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Organization is required - expenses always belong to an org
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Project is optional - null means general business expense (overhead)
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(), // Amount in cents
    date: date("date").notNull(),
    // Optional receipt attachment
    receiptFileId: uuid("receipt_file_id").references(() => projectFiles.id, { onDelete: "set null" }),
    // Category for grouping/filtering
    category: text("category"), // e.g., 'software', 'hosting', 'contractor', 'travel', 'supplies'
    // Whether this expense should be billed to the client
    isBillable: boolean("is_billable").default(false),
    // Source of the expense (for Plaid/email imports)
    source: text("source").default("manual"), // 'manual', 'plaid', 'email'
    externalId: text("external_id"), // Plaid transaction ID or email message ID
    // Recurring expense support
    isRecurring: boolean("is_recurring").default(false),
    recurringFrequency: text("recurring_frequency"), // 'weekly', 'monthly', 'quarterly', 'yearly'
    nextOccurrence: date("next_occurrence"), // Next date to generate expense (for cron)
    recurringEndDate: date("recurring_end_date"), // Optional: when to stop recurring
    parentExpenseId: uuid("parent_expense_id"), // Links generated expenses to the recurring template
    // Vendor for tracking where money is spent
    vendor: text("vendor"),
    // Payment status tracking
    status: text("status").$type<ExpenseStatus>().default("paid"),
    paidAt: date("paid_at"), // When the expense was marked as paid
    // Tracking
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_expenses_org_id_idx").on(table.organizationId),
    index("project_expenses_project_id_idx").on(table.projectId),
    index("project_expenses_date_idx").on(table.date),
    index("project_expenses_created_by_idx").on(table.createdBy),
    index("project_expenses_status_idx").on(table.status),
  ]
);

// Expense comments (discussion on expenses)
export const expenseComments = pgTable("expense_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  expenseId: uuid("expense_id")
    .notNull()
    .references(() => projectExpenses.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isShared: boolean("is_shared").default(false), // false = internal, true = client-visible
  sharedAt: timestamp("shared_at"),
  sharedBy: text("shared_by").references(() => users.id, { onDelete: "set null" }),
  isPinned: boolean("is_pinned").default(false),
  pinnedAt: timestamp("pinned_at"),
  pinnedBy: text("pinned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Expense watchers
export const expenseWatchers = pgTable(
  "expense_watchers",
  {
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => projectExpenses.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"), // 'creator', 'commenter', 'manual'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.expenseId, t.userId] }),
  })
);

// Inbox item statuses
export const INBOX_ITEM_STATUSES = ["needs_review", "converted", "informational", "discarded"] as const;
export type InboxItemStatus = (typeof INBOX_ITEM_STATUSES)[number];

// Inbox items (email-forwarded records awaiting review)
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalEmailId: text("external_email_id"),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    subject: text("subject"),
    receivedAt: timestamp("received_at").notNull(),
    status: text("status").$type<InboxItemStatus>().notNull().default("needs_review"),
    convertedExpenseId: uuid("converted_expense_id").references(() => projectExpenses.id, { onDelete: "set null" }),
    convertedTo: text("converted_to").$type<"expense" | "file" | "discussion" | "task" | "transfer">(),
    // Entity association (set when email is sent to a client/project intake address)
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("inbox_items_org_id_idx").on(table.organizationId),
    index("inbox_items_status_idx").on(table.organizationId, table.status),
    index("inbox_items_received_at_idx").on(table.receivedAt),
    index("inbox_items_client_id_idx").on(table.clientId),
    index("inbox_items_project_id_idx").on(table.projectId),
  ]
);

// Inbox item files (attachments extracted from forwarded emails)
export const inboxItemFiles = pgTable(
  "inbox_item_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inboxItemId: uuid("inbox_item_id")
      .notNull()
      .references(() => inboxItems.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type").notNull(),
    r2Key: text("r2_key").notNull(),
    source: text("source").default("attachment"), // 'attachment' | 'cloud_url'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("inbox_item_files_item_id_idx").on(table.inboxItemId),
  ]
);

// Email send entity types (what kind of email was sent)
export const EMAIL_SEND_ENTITY_TYPES = [
  "invitation",
  "invoice",
  "document",
  "notification",
  "lifecycle",
] as const;
export type EmailSendEntityType = (typeof EMAIL_SEND_ENTITY_TYPES)[number];

// Email send statuses
export const EMAIL_SEND_STATUSES = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "opened",
  "clicked",
] as const;
export type EmailSendStatus = (typeof EMAIL_SEND_STATUSES)[number];

// Outbound email tracking
export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalEmailId: text("external_email_id").notNull().unique(),
    entityType: text("entity_type").$type<EmailSendEntityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject"),
    status: text("status").$type<EmailSendStatus>().notNull().default("sent"),
    sentAt: timestamp("sent_at").defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at"),
    openedAt: timestamp("opened_at"),
    bouncedAt: timestamp("bounced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("email_sends_org_idx").on(table.organizationId),
    index("email_sends_external_id_idx").on(table.externalEmailId),
    index("email_sends_entity_idx").on(table.entityType, table.entityId),
  ]
);

// Notification types
export const NOTIFICATION_TYPES = [
  "assigned",
  "mentioned",
  "status_changed",
  "comment",
  "blocker_resolved",
  "client_comment",
  "edit_requested",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// User notification preferences
export const notificationPreferences = pgTable("notification_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  assignedToYou: boolean("assigned_to_you").default(true),
  mentioned: boolean("mentioned").default(true),
  watchedTaskChanged: boolean("watched_task_changed").default(true),
  blockerResolved: boolean("blocker_resolved").default(true),
  clientComment: boolean("client_comment").default(true),
  emailEnabled: boolean("email_enabled").default(true),
  emailDelivery: text("email_delivery").default("immediate"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// User settings (per-user preferences like calendar ICS URL)
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  calendarIcsUrl: text("calendar_ics_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notifications inbox
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<NotificationType>().notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    content: text("content"),
    isRead: boolean("is_read").default(false),
    emailSent: boolean("email_sent").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("notifications_user_id_idx").on(table.userId),
    index("notifications_user_read_idx").on(table.userId, table.isRead),
  ]
);

// Activity entity types
export const ACTIVITY_ENTITY_TYPES = [
  "task",
  "project",
  "expense",
  "invoice",
  "document",
  "time_entry",
  "contact",
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

// Activity actions
export const ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "deleted",
  "archived",
  "status_changed",
  "assigned",
  "unassigned",
  "estimate_changed",
  "type_changed",
  "blocker_added",
  "blocker_removed",
  "blocker_resolved",
  "related_added",
  "related_removed",
  "commented",
  "comment_shared",
  "file_attached",
  "file_removed",
  "visibility_changed",
  // Email delivery tracking
  "email_sent",
  "email_delivered",
  "email_bounced",
  "email_opened",
  "email_clicked",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

// Global activity log (replaces project_activities for new usage)
export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Who
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").default("user"), // 'user', 'client', 'system'
    // What entity
    entityType: text("entity_type").$type<ActivityEntityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    // Parent context (for contextual queries)
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    // What happened
    action: text("action").$type<ActivityAction>().notNull(),
    field: text("field"), // Which field changed
    oldValue: text("old_value"),
    newValue: text("new_value"),
    metadata: jsonb("metadata"), // Extra context
    // Visibility
    isClientVisible: boolean("is_client_visible").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("activities_org_idx").on(table.organizationId, table.createdAt),
    index("activities_project_idx").on(table.projectId, table.createdAt),
    index("activities_task_idx").on(table.taskId, table.createdAt),
    index("activities_entity_idx").on(table.entityType, table.entityId),
  ]
);

// Scope clients (widget installations on client sites)
export const scopeClients = pgTable(
  "scope_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    defaultProjectId: uuid("default_project_id")
      .references(() => projects.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    token: text("token").notNull().unique(),
    domains: jsonb("domains").$type<string[]>().default([]),
    publicAccess: boolean("public_access").default(false),
    enabled: boolean("enabled").default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("scope_clients_token_idx").on(table.token),
    index("scope_clients_org_idx").on(table.organizationId),
    index("scope_clients_client_idx").on(table.clientId),
  ]
);

// Site heartbeats (passive monitoring data from scope clients)
export const siteHeartbeats = pgTable(
  "site_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeClientId: uuid("scope_client_id")
      .notNull()
      .references(() => scopeClients.id, { onDelete: "cascade" }),
    pageUrl: text("page_url").notNull(),
    metrics: jsonb("metrics").notNull(),
    metadata: jsonb("metadata"),
    pingMs: integer("ping_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("site_heartbeats_scope_client_created_idx").on(table.scopeClientId, table.createdAt),
    index("site_heartbeats_org_created_idx").on(table.organizationId, table.createdAt),
  ]
);


// Relations
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  teamInvitations: many(teamInvitations),
  clients: many(clients),
  timeEntries: many(timeEntries),
  reportConfigs: many(reportConfigs),
  invoices: many(invoices),
  importSessions: many(importSessions),
  recurringTemplates: many(recurringTemplates),
  documents: many(documents),
  documentTemplates: many(documentTemplates),
  expenses: many(projectExpenses),
  taskTypes: many(taskTypes),
  taskTags: many(taskTags),
  activities: many(activities),
  savedReportPresets: many(savedReportPresets),
  scopeClients: many(scopeClients),
  inboxItems: many(inboxItems),
  emailSends: many(emailSends),
}));

export const importSessionsRelations = relations(importSessions, ({ one }) => ({
  organization: one(organizations, {
    fields: [importSessions.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [importSessions.userId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  timeEntries: many(timeEntries),
  sessions: many(sessions),
  accounts: many(accounts),
  passkeys: many(passkeys),
  twoFactors: many(twoFactors),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, {
    fields: [passkeys.userId],
    references: [users.id],
  }),
}));

export const twoFactorsRelations = relations(twoFactors, ({ one }) => ({
  user: one(users, {
    fields: [twoFactors.userId],
    references: [users.id],
  }),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
}));

export const teamInvitationsRelations = relations(
  teamInvitations,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [teamInvitations.organizationId],
      references: [organizations.id],
    }),
    inviter: one(users, {
      fields: [teamInvitations.invitedBy],
      references: [users.id],
    }),
  })
);

export const projectMembersRelations = relations(
  projectMembers,
  ({ one }) => ({
    project: one(projects, {
      fields: [projectMembers.projectId],
      references: [projects.id],
    }),
    user: one(users, {
      fields: [projectMembers.userId],
      references: [users.id],
    }),
  })
);

export const clientsRelations = relations(clients, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [clients.organizationId],
    references: [organizations.id],
  }),
  parentClient: one(clients, {
    fields: [clients.parentClientId],
    references: [clients.id],
    relationName: "clientHierarchy",
  }),
  childClients: many(clients, {
    relationName: "clientHierarchy",
  }),
  projects: many(projects),
  invoices: many(invoices),
  comments: many(clientComments),
  contacts: many(clientContacts),
  invitations: many(clientInvitations),
  retainerPeriods: many(retainerPeriods),
  scopeClients: many(scopeClients),
}));

export const retainerPeriodsRelations = relations(retainerPeriods, ({ one }) => ({
  client: one(clients, {
    fields: [retainerPeriods.clientId],
    references: [clients.id],
  }),
  organization: one(organizations, {
    fields: [retainerPeriods.organizationId],
    references: [organizations.id],
  }),
  invoice: one(invoices, {
    fields: [retainerPeriods.invoiceId],
    references: [invoices.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  client: one(clients, {
    fields: [projects.clientId],
    references: [clients.id],
  }),
  tasks: many(tasks),
  invitations: many(projectInvitations),
  files: many(projectFiles),
  activities: many(projectActivities),
  documents: many(documents),
  expenses: many(projectExpenses),
  comments: many(projectComments),
  onboardingItems: many(onboardingItems),
  dataExportRequests: many(dataExportRequests),
  projectContacts: many(projectContacts),
  members: many(projectMembers),
}));

export const onboardingItemsRelations = relations(onboardingItems, ({ one }) => ({
  project: one(projects, {
    fields: [onboardingItems.projectId],
    references: [projects.id],
  }),
  completedByUser: one(users, {
    fields: [onboardingItems.completedBy],
    references: [users.id],
  }),
}));

export const dataExportRequestsRelations = relations(dataExportRequests, ({ one }) => ({
  project: one(projects, {
    fields: [dataExportRequests.projectId],
    references: [projects.id],
  }),
  organization: one(organizations, {
    fields: [dataExportRequests.organizationId],
    references: [organizations.id],
  }),
  requestedByUser: one(users, {
    fields: [dataExportRequests.requestedBy],
    references: [users.id],
  }),
}));

export const projectInvitationsRelations = relations(projectInvitations, ({ one }) => ({
  project: one(projects, {
    fields: [projectInvitations.projectId],
    references: [projects.id],
  }),
  contact: one(clientContacts, {
    fields: [projectInvitations.contactId],
    references: [clientContacts.id],
  }),
  invitedByUser: one(users, {
    fields: [projectInvitations.invitedBy],
    references: [users.id],
    relationName: "invitedBy",
  }),
  user: one(users, {
    fields: [projectInvitations.userId],
    references: [users.id],
    relationName: "acceptedUser",
  }),
}));

export const projectFilesRelations = relations(projectFiles, ({ one }) => ({
  project: one(projects, {
    fields: [projectFiles.projectId],
    references: [projects.id],
  }),
  uploadedByUser: one(users, {
    fields: [projectFiles.uploadedBy],
    references: [users.id],
  }),
  replaces: one(projectFiles, {
    fields: [projectFiles.replacesId],
    references: [projectFiles.id],
    relationName: "fileSuperseding",
  }),
}));

export const projectActivitiesRelations = relations(projectActivities, ({ one }) => ({
  project: one(projects, {
    fields: [projectActivities.projectId],
    references: [projects.id],
  }),
  actor: one(users, {
    fields: [projectActivities.actorId],
    references: [users.id],
  }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  revisions: many(documentRevisions),
  organization: one(organizations, {
    fields: [documents.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [documents.projectId],
    references: [projects.id],
  }),
  template: one(documentTemplates, {
    fields: [documents.templateId],
    references: [documentTemplates.id],
  }),
  createdByUser: one(users, {
    fields: [documents.createdBy],
    references: [users.id],
  }),
}));

export const documentRevisionsRelations = relations(documentRevisions, ({ one }) => ({
  document: one(documents, {
    fields: [documentRevisions.documentId],
    references: [documents.id],
  }),
  savedByUser: one(users, {
    fields: [documentRevisions.savedBy],
    references: [users.id],
  }),
}));

export const documentTemplatesRelations = relations(documentTemplates, ({ one }) => ({
  organization: one(organizations, {
    fields: [documentTemplates.organizationId],
    references: [organizations.id],
  }),
  createdByUser: one(users, {
    fields: [documentTemplates.createdBy],
    references: [users.id],
  }),
}));

export const projectExpensesRelations = relations(projectExpenses, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projectExpenses.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [projectExpenses.projectId],
    references: [projects.id],
  }),
  receiptFile: one(projectFiles, {
    fields: [projectExpenses.receiptFileId],
    references: [projectFiles.id],
  }),
  createdByUser: one(users, {
    fields: [projectExpenses.createdBy],
    references: [users.id],
  }),
  comments: many(expenseComments),
  watchers: many(expenseWatchers),
}));

export const expenseWatchersRelations = relations(expenseWatchers, ({ one }) => ({
  expense: one(projectExpenses, {
    fields: [expenseWatchers.expenseId],
    references: [projectExpenses.id],
  }),
  user: one(users, {
    fields: [expenseWatchers.userId],
    references: [users.id],
  }),
}));

// Inbox items relations
export const inboxItemsRelations = relations(inboxItems, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [inboxItems.organizationId],
    references: [organizations.id],
  }),
  convertedExpense: one(projectExpenses, {
    fields: [inboxItems.convertedExpenseId],
    references: [projectExpenses.id],
  }),
  client: one(clients, {
    fields: [inboxItems.clientId],
    references: [clients.id],
  }),
  project: one(projects, {
    fields: [inboxItems.projectId],
    references: [projects.id],
  }),
  files: many(inboxItemFiles),
}));

// Inbox item files relations
export const inboxItemFilesRelations = relations(inboxItemFiles, ({ one }) => ({
  inboxItem: one(inboxItems, {
    fields: [inboxItemFiles.inboxItemId],
    references: [inboxItems.id],
  }),
}));

// Email sends relations
export const emailSendsRelations = relations(emailSends, ({ one }) => ({
  organization: one(organizations, {
    fields: [emailSends.organizationId],
    references: [organizations.id],
  }),
}));

export const expenseCommentsRelations = relations(expenseComments, ({ one }) => ({
  expense: one(projectExpenses, {
    fields: [expenseComments.expenseId],
    references: [projectExpenses.id],
  }),
  author: one(users, {
    fields: [expenseComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [expenseComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [expenseComments.pinnedBy],
    references: [users.id],
  }),
}));

export const projectCommentsRelations = relations(projectComments, ({ one }) => ({
  project: one(projects, {
    fields: [projectComments.projectId],
    references: [projects.id],
  }),
  author: one(users, {
    fields: [projectComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [projectComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [projectComments.pinnedBy],
    references: [users.id],
  }),
}));

export const clientCommentsRelations = relations(clientComments, ({ one }) => ({
  client: one(clients, {
    fields: [clientComments.clientId],
    references: [clients.id],
  }),
  author: one(users, {
    fields: [clientComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [clientComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [clientComments.pinnedBy],
    references: [users.id],
  }),
}));

export const clientContactsRelations = relations(clientContacts, ({ one, many }) => ({
  client: one(clients, {
    fields: [clientContacts.clientId],
    references: [clients.id],
  }),
  comments: many(contactComments),
  watchers: many(contactWatchers),
  projectContacts: many(projectContacts),
  clientInvitations: many(clientInvitations),
  projectInvitations: many(projectInvitations),
}));

export const contactCommentsRelations = relations(contactComments, ({ one }) => ({
  contact: one(clientContacts, {
    fields: [contactComments.contactId],
    references: [clientContacts.id],
  }),
  author: one(users, {
    fields: [contactComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [contactComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [contactComments.pinnedBy],
    references: [users.id],
  }),
}));

export const contactWatchersRelations = relations(contactWatchers, ({ one }) => ({
  contact: one(clientContacts, {
    fields: [contactWatchers.contactId],
    references: [clientContacts.id],
  }),
  user: one(users, {
    fields: [contactWatchers.userId],
    references: [users.id],
  }),
}));

export const projectContactsRelations = relations(projectContacts, ({ one }) => ({
  project: one(projects, {
    fields: [projectContacts.projectId],
    references: [projects.id],
  }),
  contact: one(clientContacts, {
    fields: [projectContacts.contactId],
    references: [clientContacts.id],
  }),
}));

export const clientInvitationsRelations = relations(clientInvitations, ({ one }) => ({
  client: one(clients, {
    fields: [clientInvitations.clientId],
    references: [clients.id],
  }),
  contact: one(clientContacts, {
    fields: [clientInvitations.contactId],
    references: [clientContacts.id],
  }),
  invitedByUser: one(users, {
    fields: [clientInvitations.invitedBy],
    references: [users.id],
    relationName: "clientInvitedBy",
  }),
  user: one(users, {
    fields: [clientInvitations.userId],
    references: [users.id],
    relationName: "clientAcceptedUser",
  }),
}));

export const invoiceCommentsRelations = relations(invoiceComments, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceComments.invoiceId],
    references: [invoices.id],
  }),
  author: one(users, {
    fields: [invoiceComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [invoiceComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [invoiceComments.pinnedBy],
    references: [users.id],
  }),
}));

export const documentCommentsRelations = relations(documentComments, ({ one }) => ({
  document: one(documents, {
    fields: [documentComments.documentId],
    references: [documents.id],
  }),
  author: one(users, {
    fields: [documentComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [documentComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [documentComments.pinnedBy],
    references: [users.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  type: one(taskTypes, {
    fields: [tasks.typeId],
    references: [taskTypes.id],
  }),
  assignedToUser: one(users, {
    fields: [tasks.assignedTo],
    references: [users.id],
  }),
  createdByUser: one(users, {
    fields: [tasks.createdBy],
    references: [users.id],
  }),
  timeEntries: many(timeEntries),
  tagAssignments: many(taskTagAssignments),
  comments: many(taskComments),
  watchers: many(taskWatchers),
  files: many(taskFiles),
  // Relationships where this task is the source
  outgoingRelationships: many(taskRelationships, { relationName: "sourceTask" }),
  // Relationships where this task is the target
  incomingRelationships: many(taskRelationships, { relationName: "targetTask" }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  organization: one(organizations, {
    fields: [timeEntries.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [timeEntries.userId],
    references: [users.id],
  }),
  client: one(clients, {
    fields: [timeEntries.clientId],
    references: [clients.id],
  }),
  project: one(projects, {
    fields: [timeEntries.projectId],
    references: [projects.id],
  }),
  task: one(tasks, {
    fields: [timeEntries.taskId],
    references: [tasks.id],
  }),
}));

export const reportConfigsRelations = relations(reportConfigs, ({ one }) => ({
  organization: one(organizations, {
    fields: [reportConfigs.organizationId],
    references: [organizations.id],
  }),
  client: one(clients, {
    fields: [reportConfigs.clientId],
    references: [clients.id],
  }),
  project: one(projects, {
    fields: [reportConfigs.projectId],
    references: [projects.id],
  }),
}));

export const savedReportPresetsRelations = relations(
  savedReportPresets,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [savedReportPresets.organizationId],
      references: [organizations.id],
    }),
    user: one(users, {
      fields: [savedReportPresets.userId],
      references: [users.id],
    }),
  })
);

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [invoices.organizationId],
    references: [organizations.id],
  }),
  client: one(clients, {
    fields: [invoices.clientId],
    references: [clients.id],
  }),
  lineItems: many(invoiceLineItems),
}));

export const invoiceLineItemsRelations = relations(
  invoiceLineItems,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoiceLineItems.invoiceId],
      references: [invoices.id],
    }),
  })
);

export const recurringTemplatesRelations = relations(
  recurringTemplates,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [recurringTemplates.organizationId],
      references: [organizations.id],
    }),
    user: one(users, {
      fields: [recurringTemplates.userId],
      references: [users.id],
    }),
    client: one(clients, {
      fields: [recurringTemplates.clientId],
      references: [clients.id],
    }),
    project: one(projects, {
      fields: [recurringTemplates.projectId],
      references: [projects.id],
    }),
    task: one(tasks, {
      fields: [recurringTemplates.taskId],
      references: [tasks.id],
    }),
  })
);

// Task types relations
export const taskTypesRelations = relations(taskTypes, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [taskTypes.organizationId],
    references: [organizations.id],
  }),
  tasks: many(tasks),
}));

// Task tags relations
export const taskTagsRelations = relations(taskTags, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [taskTags.organizationId],
    references: [organizations.id],
  }),
  assignments: many(taskTagAssignments),
}));

// Task tag assignments relations
export const taskTagAssignmentsRelations = relations(taskTagAssignments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTagAssignments.taskId],
    references: [tasks.id],
  }),
  tag: one(taskTags, {
    fields: [taskTagAssignments.tagId],
    references: [taskTags.id],
  }),
}));

// Task relationships relations
export const taskRelationshipsRelations = relations(taskRelationships, ({ one }) => ({
  sourceTask: one(tasks, {
    fields: [taskRelationships.sourceTaskId],
    references: [tasks.id],
    relationName: "sourceTask",
  }),
  targetTask: one(tasks, {
    fields: [taskRelationships.targetTaskId],
    references: [tasks.id],
    relationName: "targetTask",
  }),
  createdByUser: one(users, {
    fields: [taskRelationships.createdBy],
    references: [users.id],
  }),
}));

// Task files relations
export const taskFilesRelations = relations(taskFiles, ({ one }) => ({
  task: one(tasks, {
    fields: [taskFiles.taskId],
    references: [tasks.id],
  }),
  file: one(projectFiles, {
    fields: [taskFiles.fileId],
    references: [projectFiles.id],
  }),
}));

// Task comments relations
export const taskCommentsRelations = relations(taskComments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
  author: one(users, {
    fields: [taskComments.authorId],
    references: [users.id],
  }),
  sharedByUser: one(users, {
    fields: [taskComments.sharedBy],
    references: [users.id],
  }),
  pinnedByUser: one(users, {
    fields: [taskComments.pinnedBy],
    references: [users.id],
  }),
}));

// Task watchers relations
export const taskWatchersRelations = relations(taskWatchers, ({ one }) => ({
  task: one(tasks, {
    fields: [taskWatchers.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskWatchers.userId],
    references: [users.id],
  }),
}));

// Project watchers relations
export const projectWatchersRelations = relations(projectWatchers, ({ one }) => ({
  project: one(projects, {
    fields: [projectWatchers.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectWatchers.userId],
    references: [users.id],
  }),
}));

// Notification preferences relations
export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(users, {
    fields: [notificationPreferences.userId],
    references: [users.id],
  }),
}));

// User settings relations
export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, {
    fields: [userSettings.userId],
    references: [users.id],
  }),
}));

// Notifications relations
export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
  task: one(tasks, {
    fields: [notifications.taskId],
    references: [tasks.id],
  }),
  actor: one(users, {
    fields: [notifications.actorId],
    references: [users.id],
  }),
}));

// Activities relations
export const activitiesRelations = relations(activities, ({ one }) => ({
  organization: one(organizations, {
    fields: [activities.organizationId],
    references: [organizations.id],
  }),
  actor: one(users, {
    fields: [activities.actorId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [activities.projectId],
    references: [projects.id],
  }),
  task: one(tasks, {
    fields: [activities.taskId],
    references: [tasks.id],
  }),
}));

// Scope clients relations
export const scopeClientsRelations = relations(scopeClients, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [scopeClients.organizationId],
    references: [organizations.id],
  }),
  client: one(clients, {
    fields: [scopeClients.clientId],
    references: [clients.id],
  }),
  defaultProject: one(projects, {
    fields: [scopeClients.defaultProjectId],
    references: [projects.id],
  }),
  heartbeats: many(siteHeartbeats),
}));

// Site heartbeats relations
export const siteHeartbeatsRelations = relations(siteHeartbeats, ({ one }) => ({
  organization: one(organizations, {
    fields: [siteHeartbeats.organizationId],
    references: [organizations.id],
  }),
  scopeClient: one(scopeClients, {
    fields: [siteHeartbeats.scopeClientId],
    references: [scopeClients.id],
  }),
}));

