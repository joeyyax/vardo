import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, cronJobs, organizations } from "@/lib/db/schema";
import { isSystemExecTarget } from "@/lib/api/system-exec";
import {
  CronInputError,
  createValues,
  cronCreateSchema,
  cronUpdateSchema,
  recentRuns,
  serializeCronJob,
  updateValues,
} from "@/lib/cron/jobs";
import { CRON_METHODS, MAX_RETRIES, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "@/lib/cron/url-options";
import type { McpAuthContext } from "../auth";
import { accessDenied, accessibleOrgIds, canAccessOrg, orgFilter, resolveTargetOrg } from "../scope";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

const jobOptions = {
  method: z.enum(CRON_METHODS).optional().describe("URL jobs: HTTP method (default GET)"),
  headers: z
    .array(z.object({ name: z.string(), value: z.string().optional() }))
    .optional()
    .describe("URL jobs: request headers, stored encrypted. On update the list replaces the old one; omit a value to keep the stored one."),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional().describe("URL jobs: per-attempt timeout in ms (default 30000, max 300000)"),
  retries: z.number().int().min(0).max(MAX_RETRIES).optional().describe("URL jobs: retries on failure with exponential backoff (0-3)"),
  expectedStatus: z.string().nullable().optional().describe('URL jobs: status codes that count as success, e.g. "2xx" or "200,204" (default 2xx)'),
  timeZone: z
    .string()
    .nullable()
    .optional()
    .describe('IANA zone the schedule runs in, e.g. "America/Los_Angeles". Null or omitted runs in the server\'s zone (UTC in the stock image).'),
};

const JOB_SCOPE = {
  organization: { columns: { isSystemManaged: true } },
  app: { columns: { id: true, name: true, displayName: true, organizationId: true, isSystemManaged: true } },
} as const;

export function registerCronJobTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_cron_jobs",
    "List cron jobs: org-level URL jobs and every app's jobs, with schedule, last status and header names (values masked). Pass appId for one app's jobs, or cronJobId for one job with its recent runs.",
    {
      appId: z.string().optional().describe("Only this app's jobs"),
      cronJobId: z.string().optional().describe("One job, with its recent runs"),
      runs: z.number().int().min(1).max(100).default(10).describe("Runs to include with cronJobId"),
    },
    async ({ appId, cronJobId, runs }) => {
      const orgIds = await accessibleOrgIds(context, "app.view");
      const filters = [orgFilter(cronJobs.organizationId, orgIds)];
      if (appId) filters.push(eq(cronJobs.appId, appId));
      if (cronJobId) filters.push(eq(cronJobs.id, cronJobId));

      const jobs = await db.query.cronJobs.findMany({
        where: and(...filters),
        with: { app: { columns: { id: true, name: true, displayName: true } } },
        orderBy: (j, { asc }) => [asc(j.name)],
      });

      if (cronJobId) {
        const [job] = jobs;
        if (!job) return accessDenied("Cron job");
        return text({ cronJob: serializeCronJob(job), runs: await recentRuns(job.id, runs) });
      }
      return text({ cronJobs: jobs.map(serializeCronJob) });
    }
  );

  server.tool(
    "vardo_create_cron_job",
    "Create a cron job. Without appId it's an org-level URL job that needs no app, e.g. hitting a site's wp-cron.php every 10 minutes. With appId it belongs to that app and may also be a command job, which needs an admin.",
    {
      organizationId: z.string().optional().describe("Org for an org-level job; defaults to the token's org"),
      appId: z.string().optional().describe("App the job belongs to; omit for an org-level URL job"),
      name: z.string().describe("Job name"),
      schedule: z.string().describe('Cron expression, e.g. "*/10 * * * *"'),
      type: z.enum(["command", "url"]).default("url").describe("url sends an HTTP request; command runs sh -c in the app's container"),
      command: z.string().describe("The URL for a URL job, or the shell command"),
      enabled: z.boolean().default(true),
      ...jobOptions,
    },
    async ({ organizationId, appId, ...input }) => {
      let orgId: string | null;
      let systemTarget = false;
      if (appId) {
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
          columns: { id: true, organizationId: true, isSystemManaged: true },
          with: { organization: { columns: { isSystemManaged: true } } },
        });
        orgId = app && (await canAccessOrg(context, app.organizationId, "app.cron")) ? app.organizationId : null;
        systemTarget = Boolean(app && isSystemExecTarget(app.organization, app));
      } else {
        orgId = await resolveTargetOrg(context, organizationId, "app.cron");
        if (orgId) {
          const org = await db.query.organizations.findFirst({
            where: eq(organizations.id, orgId),
            columns: { isSystemManaged: true },
          });
          systemTarget = isSystemExecTarget(org, null);
        }
      }
      if (!orgId || systemTarget) return accessDenied(appId ? "App" : "Organization");

      const parsed = cronCreateSchema.safeParse(input);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");
      if (parsed.data.type === "command") {
        if (!appId) return failure("Command jobs need an app");
        if (!(await canAccessOrg(context, orgId, "app.cron.command"))) return failure("Command jobs need an admin");
      }

      try {
        const [created] = await db.insert(cronJobs).values(createValues(parsed.data, orgId, appId ?? null)).returning();
        return text({ cronJob: serializeCronJob(created) });
      } catch (err) {
        if (err instanceof CronInputError) return failure(err.message);
        throw err;
      }
    }
  );

  server.tool(
    "vardo_update_cron_job",
    "Update a cron job's name, schedule, URL or command, enabled flag or URL options. Changing what a command job runs needs an admin.",
    {
      cronJobId: z.string().describe("The cron job ID"),
      name: z.string().optional(),
      schedule: z.string().optional().describe("Cron expression"),
      type: z.enum(["command", "url"]).optional(),
      command: z.string().optional().describe("The URL for a URL job, or the shell command"),
      enabled: z.boolean().optional(),
      ...jobOptions,
    },
    async ({ cronJobId, ...input }) => {
      const job = await db.query.cronJobs.findFirst({ where: eq(cronJobs.id, cronJobId), with: JOB_SCOPE });
      if (!job) return accessDenied("Cron job");

      const type = input.type ?? job.type;
      const changesCommand =
        type === "command" && (type !== job.type || (input.command !== undefined && input.command !== job.command));
      // MCP cron tools never act as instance admin, so cron on Vardo's own org and apps stays session-only.
      const allowed =
        !isSystemExecTarget(job.organization, job.app) &&
        (await canAccessOrg(context, job.organizationId, "app.cron")) &&
        (!changesCommand || (await canAccessOrg(context, job.organizationId, "app.cron.command")));
      if (!allowed) return accessDenied("Cron job");
      if (type === "command" && !job.appId) return failure("Command jobs need an app");

      const parsed = cronUpdateSchema.safeParse(input);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");

      try {
        const [updated] = await db
          .update(cronJobs)
          .set(updateValues(parsed.data, job, job.organizationId))
          .where(eq(cronJobs.id, job.id))
          .returning();
        return text({ cronJob: serializeCronJob(updated) });
      } catch (err) {
        if (err instanceof CronInputError) return failure(err.message);
        throw err;
      }
    }
  );

  server.tool(
    "vardo_delete_cron_job",
    "Delete a cron job and its run history.",
    {
      cronJobId: z.string().describe("The cron job ID"),
    },
    async ({ cronJobId }) => {
      const job = await db.query.cronJobs.findFirst({ where: eq(cronJobs.id, cronJobId), with: JOB_SCOPE });
      const allowed =
        job && !isSystemExecTarget(job.organization, job.app) && (await canAccessOrg(context, job.organizationId, "app.cron"));
      if (!job || !allowed) return accessDenied("Cron job");

      await db.delete(cronJobs).where(eq(cronJobs.id, job.id));
      return text({ deleted: job.id });
    }
  );
}
