// Cron job input, storage and output shared by the API routes and MCP tools.

import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { cronJobRuns, cronJobs } from "@/lib/db/schema";
import { decryptHeaders, encryptHeaders, HeaderValueMissingError, maskHeaders, mergeHeaders } from "./headers";
import { isValidSchedule } from "./parse";
import { urlOptionsShape } from "./url-options";
import { isValidTimeZone } from "@/lib/time-zone";

export const scheduleSchema = z
  .string()
  .trim()
  .min(1, "Schedule is required")
  .refine(isValidSchedule, "Schedule isn't a valid cron expression");

const fields = {
  name: z.string().trim().min(1, "Name is required").max(200),
  type: z.enum(["command", "url"]),
  schedule: scheduleSchema,
  command: z.string().trim().min(1, "Command is required").max(4096),
  enabled: z.boolean(),
  // Null runs in the server's zone.
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").nullable(),
};

export const cronCreateSchema = z
  .object({
    ...fields,
    type: fields.type.default("command"),
    enabled: fields.enabled.optional().default(true),
    timeZone: fields.timeZone.optional(),
    ...urlOptionsShape,
  })
  .strict();

export const cronUpdateSchema = z
  .object({
    name: fields.name.optional(),
    type: fields.type.optional(),
    schedule: fields.schedule.optional(),
    command: fields.command.optional(),
    enabled: fields.enabled.optional(),
    timeZone: fields.timeZone.optional(),
    ...urlOptionsShape,
  })
  .strict();

/** Org-level jobs are URL jobs only. */
export const orgCronCreateSchema = cronCreateSchema
  .extend({ type: z.literal("url").optional().default("url") })
  .strict();
export const orgCronUpdateSchema = cronUpdateSchema.extend({ type: z.literal("url").optional() }).strict();

export type CronCreateInput = z.infer<typeof cronCreateSchema>;
export type CronUpdateInput = z.infer<typeof cronUpdateSchema>;

/** Input a caller can fix: bad URL, missing header value. */
export class CronInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronInputError";
  }
}

function assertUrl(command: string): void {
  let url: URL;
  try {
    url = new URL(command);
  } catch {
    throw new CronInputError("URL isn't valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CronInputError("URL must start with http:// or https://");
  }
}

type Stored = { type: "command" | "url"; command: string; headers: string | null };

/** Column values for the URL options in `input`, with headers merged over `stored` and encrypted. */
export function urlColumns(input: Partial<CronUpdateInput>, orgId: string, storedHeaders: string | null = null) {
  const out: {
    method?: string;
    headers?: string | null;
    timeoutMs?: number;
    retries?: number;
    expectedStatus?: string | null;
  } = {};
  if (input.method !== undefined) out.method = input.method;
  if (input.timeoutMs !== undefined) out.timeoutMs = input.timeoutMs;
  if (input.retries !== undefined) out.retries = input.retries;
  if (input.expectedStatus !== undefined) out.expectedStatus = input.expectedStatus?.trim() || null;
  if (input.headers !== undefined) {
    let stored: { name: string; value: string }[] = [];
    try {
      stored = decryptHeaders(storedHeaders, orgId);
    } catch {
      stored = [];
    }
    try {
      out.headers = encryptHeaders(mergeHeaders(input.headers, stored), orgId);
    } catch (err) {
      if (err instanceof HeaderValueMissingError) throw new CronInputError(err.message);
      throw err;
    }
  }
  return out;
}

/** Values for a new job. Throws CronInputError on a bad URL or header. */
export function createValues(input: CronCreateInput, orgId: string, appId: string | null) {
  if (input.type === "url") assertUrl(input.command);
  if (input.type === "command" && !appId) throw new CronInputError("Command jobs need an app");
  return {
    id: nanoid(),
    organizationId: orgId,
    appId,
    name: input.name,
    type: input.type,
    schedule: input.schedule,
    command: input.command,
    enabled: input.enabled,
    timeZone: input.timeZone ?? null,
    ...urlColumns(input, orgId),
  };
}

/** Values to set on an existing job. Throws CronInputError on a bad URL or header. */
export function updateValues(input: CronUpdateInput, current: Stored, orgId: string) {
  const type = input.type ?? current.type;
  const command = input.command ?? current.command;
  if (type === "url" && (input.command !== undefined || input.type !== undefined)) assertUrl(command);
  const { method: _m, headers: _h, timeoutMs: _t, retries: _r, expectedStatus: _e, ...rest } = input;
  return { ...rest, ...urlColumns(input, orgId, current.headers), updatedAt: new Date() };
}

type JobRow = typeof cronJobs.$inferSelect;

/** A job for API and MCP output: header values masked, never the stored blob. */
export function serializeCronJob<T extends Pick<JobRow, "headers" | "organizationId">>(job: T) {
  return { ...job, headers: maskHeaders(job.headers, job.organizationId) };
}

/** Every job in the org, org-level and per-app, with each app's name. */
export async function listOrgCronJobs(orgId: string) {
  const jobs = await db.query.cronJobs.findMany({
    where: eq(cronJobs.organizationId, orgId),
    with: { app: { columns: { id: true, name: true, displayName: true, projectId: true } } },
    orderBy: (j, { asc }) => [asc(j.name)],
  });
  return jobs.map(serializeCronJob);
}

/** An org-level job in the org, or undefined. */
export async function findOrgLevelJob(orgId: string, id: string) {
  return db.query.cronJobs.findFirst({
    where: and(eq(cronJobs.id, id), eq(cronJobs.organizationId, orgId), isNull(cronJobs.appId)),
  });
}

/** Newest runs first. */
export async function recentRuns(cronJobId: string, limit = 20) {
  return db.query.cronJobRuns.findMany({
    where: eq(cronJobRuns.cronJobId, cronJobId),
    orderBy: [desc(cronJobRuns.startedAt)],
    limit,
  });
}
