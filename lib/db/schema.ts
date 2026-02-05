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

// Organizations (tenants)
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  defaultRate: integer("default_rate"), // cents per hour
  roundingIncrement: integer("rounding_increment").default(15), // minutes
  plan: text("plan").default("free"),
  limits: jsonb("limits"),
  // Billing defaults
  defaultBillingType: text("default_billing_type").default("hourly"), // 'hourly' | 'retainer_fixed' | 'retainer_capped' | 'retainer_uncapped' | 'fixed_project'
  defaultBillingFrequency: text("default_billing_frequency"), // 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'per_project'
  defaultPaymentTermsDays: integer("default_payment_terms_days").default(30),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Tasks
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  rateOverride: integer("rate_override"),
  isBillable: boolean("is_billable"),
  isArchived: boolean("is_archived").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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

// Relations
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  clients: many(clients),
  timeEntries: many(timeEntries),
  reportConfigs: many(reportConfigs),
  invoices: many(invoices),
  importSessions: many(importSessions),
  recurringTemplates: many(recurringTemplates),
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
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  timeEntries: many(timeEntries),
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
