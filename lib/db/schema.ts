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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Feature flags type for organizations
export type OrgFeatures = {
  time_tracking: boolean;
  invoicing: boolean;
  expenses: boolean;
  pm: boolean;
  proposals: boolean;
};

// Default features for new organizations (backward compatible)
export const DEFAULT_ORG_FEATURES: OrgFeatures = {
  time_tracking: true,
  invoicing: true,
  expenses: true,
  pm: false,
  proposals: false,
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
    credentialId: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at").defaultNow(),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("passkey_user_id_idx").on(table.userId),
    index("passkey_credential_id_idx").on(table.credentialId),
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

// Clients
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  parentClientId: uuid("parent_client_id"), // Optional parent for hierarchy (e.g., Agency → End Client)
  name: text("name").notNull(),
  color: text("color"), // for UI display
  rateOverride: integer("rate_override"), // cents per hour, null = inherit
  isBillable: boolean("is_billable"), // null = inherit from org
  // Billing configuration
  billingType: text("billing_type"), // 'hourly' | 'retainer_fixed' | 'retainer_capped' | 'retainer_uncapped' | 'fixed_project'
  billingFrequency: text("billing_frequency"), // 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'per_project'
  autoGenerateInvoices: boolean("auto_generate_invoices").default(false),
  retainerAmount: integer("retainer_amount"), // cents
  billingDayOfWeek: integer("billing_day_of_week"), // 0-6 for weekly/biweekly (0=Sunday)
  billingDayOfMonth: integer("billing_day_of_month"), // 1-31 for monthly/quarterly
  paymentTermsDays: integer("payment_terms_days"), // Net X days, null = inherit from org
  lastInvoicedDate: date("last_invoiced_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Project stages
export const PROJECT_STAGES = ["lead", "proposal_sent", "active", "completed"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

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
  stage: text("stage").$type<ProjectStage>().default("active"),
  // Budget tracking
  budgetType: text("budget_type").$type<BudgetType>(), // 'hours' | 'fixed' | null
  budgetHours: integer("budget_hours"), // total hours budget
  budgetAmountCents: integer("budget_amount_cents"), // fixed price budget in cents
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Task statuses for PM feature
// null = category-only task (for time tracking), other values = work item
export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

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
  // Expanded task fields
  typeId: uuid("type_id").references(() => taskTypes.id, { onDelete: "set null" }),
  estimateMinutes: integer("estimate_minutes"),
  prLink: text("pr_link"),
  isClientVisible: boolean("is_client_visible").default(true),
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
    status: text("status").default("draft"), // draft, sent, viewed, paid
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

// Project invitations for client portal access
export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_files_project_id_idx").on(table.projectId),
    index("project_files_uploaded_by_idx").on(table.uploadedBy),
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

// Document types for proposals and contracts
export const DOCUMENT_TYPES = ["proposal", "contract"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// Document statuses
export const DOCUMENT_STATUSES = ["draft", "sent", "viewed", "accepted", "declined"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

// Expense statuses
export const EXPENSE_STATUSES = ["paid", "unpaid"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// Document section types for structured content
export type DocumentSection = {
  id: string;
  type: "intro" | "scope" | "deliverables" | "timeline" | "pricing" | "terms" | "custom";
  title: string;
  content: string; // Markdown content
  order: number;
};

export type DocumentContent = {
  sections: DocumentSection[];
  // Pricing specific fields
  pricing?: {
    type: "fixed" | "hourly" | "retainer";
    amount?: number; // cents
    rate?: number; // cents per hour
    estimatedHours?: number;
    items?: Array<{
      description: string;
      quantity: number;
      unitPrice: number; // cents
      total: number; // cents
    }>;
  };
};

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notification types
export const NOTIFICATION_TYPES = [
  "assigned",
  "mentioned",
  "status_changed",
  "comment",
  "blocker_resolved",
  "client_comment",
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

// Relations
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  clients: many(clients),
  timeEntries: many(timeEntries),
  reportConfigs: many(reportConfigs),
  invoices: many(invoices),
  importSessions: many(importSessions),
  recurringTemplates: many(recurringTemplates),
  documents: many(documents),
  expenses: many(projectExpenses),
  taskTypes: many(taskTypes),
  taskTags: many(taskTags),
  activities: many(activities),
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
}));

export const projectInvitationsRelations = relations(projectInvitations, ({ one }) => ({
  project: one(projects, {
    fields: [projectInvitations.projectId],
    references: [projects.id],
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

export const documentsRelations = relations(documents, ({ one }) => ({
  organization: one(organizations, {
    fields: [documents.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [documents.projectId],
    references: [projects.id],
  }),
  createdByUser: one(users, {
    fields: [documents.createdBy],
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

// Notification preferences relations
export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(users, {
    fields: [notificationPreferences.userId],
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
