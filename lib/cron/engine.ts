import { db } from "@/lib/db";
import { cronJobs, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { exec } from "child_process";
import { promisify } from "util";
import { listContainers } from "@/lib/docker/client";

const execAsync = promisify(exec);

/**
 * Parse a cron expression and check if it should run now.
 * Supports: minute hour dayOfMonth month dayOfWeek
 * Supports: *, *\/N, N, N-M, N,M
 */
function shouldRunNow(schedule: string, now: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const checks = [
    { value: now.getMinutes(), field: parts[0] },
    { value: now.getHours(), field: parts[1] },
    { value: now.getDate(), field: parts[2] },
    { value: now.getMonth() + 1, field: parts[3] },
    { value: now.getDay(), field: parts[4] },
  ];

  return checks.every(({ value, field }) => matchesCronField(value, field));
}

function matchesCronField(value: number, field: string): boolean {
  if (field === "*") return true;

  // */N — every N
  if (field.startsWith("*/")) {
    const interval = parseInt(field.slice(2));
    return value % interval === 0;
  }

  // Comma-separated values
  const parts = field.split(",");
  for (const part of parts) {
    // Range N-M
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      if (value >= start && value <= end) return true;
    } else {
      if (parseInt(part) === value) return true;
    }
  }

  return false;
}

/**
 * Run a command inside a project's container.
 * Returns { success, log, durationMs }.
 */
async function executeInContainer(
  projectName: string,
  command: string,
): Promise<{ success: boolean; log: string; durationMs: number }> {
  const startTime = Date.now();

  // Find a running container for this project
  const containers = await listContainers(projectName);
  const running = containers.find(c => c.state === "running");

  if (!running) {
    return {
      success: false,
      log: "No running container found for project",
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const { stdout, stderr } = await execAsync(
      `docker exec ${running.id} sh -c ${JSON.stringify(command)}`,
      { timeout: 300_000 } // 5 minute timeout
    );

    const log = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      log: log || "(no output)",
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      log: message,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Check all enabled cron jobs and run any that are due.
 * Call this every minute from a scheduler.
 */
export async function tickCronJobs(): Promise<void> {
  const now = new Date();

  const jobs = await db.query.cronJobs.findMany({
    where: eq(cronJobs.enabled, true),
    with: {
      project: {
        columns: { id: true, name: true, status: true },
      },
    },
  });

  for (const job of jobs) {
    // Skip if project isn't active
    if (job.project.status !== "active") continue;

    // Check if this job should run now
    if (!shouldRunNow(job.schedule, now)) continue;

    // Avoid running the same job twice in the same minute
    if (job.lastRunAt) {
      const lastRun = new Date(job.lastRunAt);
      if (
        lastRun.getFullYear() === now.getFullYear() &&
        lastRun.getMonth() === now.getMonth() &&
        lastRun.getDate() === now.getDate() &&
        lastRun.getHours() === now.getHours() &&
        lastRun.getMinutes() === now.getMinutes()
      ) {
        continue; // Already ran this minute
      }
    }

    // Mark as running
    await db.update(cronJobs).set({
      lastRunAt: now,
      lastStatus: "running",
      updatedAt: now,
    }).where(eq(cronJobs.id, job.id));

    // Execute
    const result = await executeInContainer(job.project.name, job.command);

    // Update status
    await db.update(cronJobs).set({
      lastStatus: result.success ? "success" : "failed",
      lastLog: result.log.slice(0, 10000), // Cap log size
      updatedAt: new Date(),
    }).where(eq(cronJobs.id, job.id));

    console.log(
      `[cron] ${job.name} (${job.project.name}): ${result.success ? "OK" : "FAILED"} in ${result.durationMs}ms`
    );
  }
}

/**
 * Create cron jobs for a project from template or config definitions.
 * Skips jobs that already exist (by name).
 */
export async function syncCronJobs(
  projectId: string,
  definitions: { name: string; schedule: string; command: string; enabled?: boolean }[],
): Promise<number> {
  const existing = await db.query.cronJobs.findMany({
    where: eq(cronJobs.projectId, projectId),
    columns: { name: true },
  });
  const existingNames = new Set(existing.map(j => j.name));

  let created = 0;
  for (const def of definitions) {
    if (existingNames.has(def.name)) continue;

    await db.insert(cronJobs).values({
      id: nanoid(),
      projectId,
      name: def.name,
      schedule: def.schedule,
      command: def.command,
      enabled: def.enabled ?? true,
    });
    created++;
  }

  return created;
}
