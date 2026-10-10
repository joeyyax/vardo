import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { runCronJob } from "@/lib/cron/engine";
import { isSystemExecTarget } from "@/lib/api/system-exec";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

export function registerRunCronJob(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_run_cron_job",
    "Run an app's cron job now. Records a normal run and returns status, exit code or HTTP status, duration and the output tail. Fails if the job is already running.",
    {
      cronJobId: z.string().describe("The cron job ID"),
    },
    async ({ cronJobId }) => {
      const job = await db.query.cronJobs.findFirst({
        where: eq(cronJobs.id, cronJobId),
        with: {
          app: {
            columns: {
              id: true,
              name: true,
              status: true,
              organizationId: true,
              displayName: true,
              parentAppId: true,
              composeService: true,
              containerName: true,
              importedContainerId: true,
              isSystemManaged: true,
            },
            with: {
              parentApp: { columns: { name: true } },
              organization: { columns: { isSystemManaged: true } },
            },
          },
        },
      });

      // Tokens never carry instance-admin power, so cron on Vardo's own apps stays session-only.
      const allowed =
        job &&
        !isSystemExecTarget(job.app.organization, job.app) &&
        (await canAccessOrg(context, job.app.organizationId, "app.cron")) &&
        (job.type !== "command" ||
          (await canAccessOrg(context, job.app.organizationId, "app.cron.command")));
      if (!job || !allowed) return accessDenied("Cron job");

      const run = await runCronJob(job);
      if (!run) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "This job is already running" }) }],
          isError: true,
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }] };
    }
  );
}
