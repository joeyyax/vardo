import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { importSessions, clients, projects, tasks, timeEntries } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ orgId: string; importId: string }>;
};

/**
 * GET /api/v1/organizations/[orgId]/imports/[importId]
 * Get import session details
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { orgId, importId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const importSession = await db.query.importSessions.findFirst({
      where: and(
        eq(importSessions.id, importId),
        eq(importSessions.organizationId, orgId),
        eq(importSessions.userId, session.user.id)
      ),
    });

    if (!importSession) {
      return NextResponse.json({ error: "Import not found" }, { status: 404 });
    }

    // Get existing clients for the UI
    const existingClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
    });

    return NextResponse.json({
      session: importSession,
      existingClients: existingClients.map((c) => ({ id: c.id, name: c.name })),
    });
  } catch (error) {
    console.error("Error fetching import session:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch import" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/v1/organizations/[orgId]/imports/[importId]
 * Update import session (save progress, confirm mappings)
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { orgId, importId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const importSession = await db.query.importSessions.findFirst({
      where: and(
        eq(importSessions.id, importId),
        eq(importSessions.organizationId, orgId),
        eq(importSessions.userId, session.user.id)
      ),
    });

    if (!importSession) {
      return NextResponse.json({ error: "Import not found" }, { status: 404 });
    }

    if (importSession.status !== "in_progress") {
      return NextResponse.json(
        { error: "Import is not in progress" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { currentStep, clientMappings, projectMappings, status } = body;

    const updates: Partial<typeof importSession> = {
      updatedAt: new Date(),
    };

    if (currentStep) updates.currentStep = currentStep;
    if (clientMappings) updates.clientMappings = clientMappings;
    if (projectMappings) updates.projectMappings = projectMappings;
    if (status) updates.status = status;

    const [updated] = await db
      .update(importSessions)
      .set(updates)
      .where(eq(importSessions.id, importId))
      .returning();

    // Calculate next step guidance
    const guidance = calculateGuidance(updated);

    return NextResponse.json({
      session: updated,
      guidance,
    });
  } catch (error) {
    console.error("Error updating import session:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update import" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/organizations/[orgId]/imports/[importId]
 * Execute the import
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { orgId, importId } = await context.params;
    const { session: authSession, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const importSession = await db.query.importSessions.findFirst({
      where: and(
        eq(importSessions.id, importId),
        eq(importSessions.organizationId, orgId),
        eq(importSessions.userId, authSession.user.id)
      ),
    });

    if (!importSession) {
      return NextResponse.json({ error: "Import not found" }, { status: 404 });
    }

    if (importSession.status !== "in_progress") {
      return NextResponse.json(
        { error: "Import is not in progress" },
        { status: 400 }
      );
    }

    // Verify all mappings are confirmed
    const clientMappings = importSession.clientMappings || [];
    const unconfirmedClients = clientMappings.filter((m) => !m.confirmed);
    if (unconfirmedClients.length > 0) {
      return NextResponse.json(
        { error: "All client mappings must be confirmed before importing" },
        { status: 400 }
      );
    }

    // Execute the import
    const result = await executeImport(
      orgId,
      authSession.user.id,
      importSession
    );

    // Update session with result
    await db
      .update(importSessions)
      .set({
        status: "completed",
        currentStep: "complete",
        result,
        processedRows: importSession.totalRows,
        updatedAt: new Date(),
      })
      .where(eq(importSessions.id, importId));

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("Error executing import:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/organizations/[orgId]/imports/[importId]
 * Cancel an import session
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { orgId, importId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await db
      .update(importSessions)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(importSessions.id, importId),
          eq(importSessions.organizationId, orgId),
          eq(importSessions.userId, session.user.id)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error cancelling import:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to cancel import" },
      { status: 500 }
    );
  }
}

// Helper to calculate guidance for the UI
function calculateGuidance(session: typeof importSessions.$inferSelect) {
  const clientMappings = session.clientMappings || [];
  const projectMappings = session.projectMappings || [];

  const unconfirmedClients = clientMappings.filter((m) => !m.confirmed);
  const lowConfidenceClients = unconfirmedClients.filter((m) => m.confidence < 0.8);
  const unconfirmedProjects = projectMappings.filter((m) => !m.confirmed);

  return {
    canAutoAdvance: unconfirmedClients.length === 0,
    needsAttention: lowConfidenceClients.length,
    clientsRemaining: unconfirmedClients.length,
    projectsRemaining: unconfirmedProjects.length,
    readyToImport:
      unconfirmedClients.length === 0 && session.currentStep === "review",
  };
}

// Execute the actual import
async function executeImport(
  orgId: string,
  userId: string,
  session: typeof importSessions.$inferSelect
) {
  const result = {
    clientsCreated: 0,
    projectsCreated: 0,
    tasksCreated: 0,
    entriesImported: 0,
    entriesSkipped: 0,
    errors: [] as string[],
  };

  const clientMappings = session.clientMappings || [];
  const rawData = session.rawData || "";

  // Create a map of source client name -> target client ID
  const clientNameToId = new Map<string, string>();

  // First, create any new clients
  for (const mapping of clientMappings) {
    if (mapping.targetId) {
      // Using existing client
      clientNameToId.set(mapping.sourceName, mapping.targetId);
    } else {
      // Create new client
      const existingClient = await db.query.clients.findFirst({
        where: and(
          eq(clients.organizationId, orgId),
          eq(clients.name, mapping.targetName)
        ),
      });

      if (existingClient) {
        clientNameToId.set(mapping.sourceName, existingClient.id);
      } else {
        const [newClient] = await db
          .insert(clients)
          .values({
            organizationId: orgId,
            name: mapping.targetName,
          })
          .returning({ id: clients.id });
        clientNameToId.set(mapping.sourceName, newClient.id);
        result.clientsCreated++;
      }
    }
  }

  // Parse and import entries based on source
  const projectCache = new Map<string, string>(); // "clientId:projectName" -> projectId
  const taskCache = new Map<string, string>(); // "projectId:taskNumber" -> taskId

  if (session.source === "toggl_combined") {
    // Combined import: workspace structure + time entries
    const combinedData = JSON.parse(rawData);
    const workspace = combinedData.workspace;
    const entriesCsv = combinedData.entries;

    // First, create projects from workspace data
    const projectMappings = session.projectMappings || [];
    const togglProjects = workspace?.projects || [];

    for (const mapping of projectMappings) {
      const clientId = clientNameToId.get(mapping.clientName);
      if (!clientId) continue;

      const projectKey = `${clientId}:${mapping.sourceName}`;
      let projectId = projectCache.get(projectKey);

      if (!projectId) {
        const existingProject = await db.query.projects.findFirst({
          where: and(
            eq(projects.clientId, clientId),
            eq(projects.name, mapping.sourceName)
          ),
        });

        if (existingProject) {
          projectId = existingProject.id;
          projectCache.set(projectKey, projectId);
        } else {
          const rateInCents = mapping.rate ? Math.round(mapping.rate * 100) : null;

          const [newProject] = await db
            .insert(projects)
            .values({
              clientId,
              name: mapping.sourceName,
              code: mapping.sourceCode,
              rateOverride: rateInCents,
              isBillable: mapping.billable ?? true,
              isArchived: mapping.isArchived || false,
            })
            .returning({ id: projects.id });
          projectId = newProject.id;
          projectCache.set(projectKey, projectId);
          result.projectsCreated++;
        }
      }
    }

    // Then import time entries from CSV
    if (entriesCsv) {
      const entryRows = parseTogglEntriesRows(entriesCsv);
      // Track imported entries in this session to prevent true duplicates
      const importedEntryKeys = new Set<string>();

      for (const row of entryRows) {
        const clientId = clientNameToId.get(row.client);
        if (!clientId) {
          result.entriesSkipped++;
          continue;
        }

        // Find or create project
        const projectKey = `${clientId}:${row.project}`;
        let projectId = projectCache.get(projectKey);

        if (!projectId) {
          const existingProject = await db.query.projects.findFirst({
            where: and(
              eq(projects.clientId, clientId),
              eq(projects.name, row.project)
            ),
          });

          if (existingProject) {
            projectId = existingProject.id;
          } else {
            const [newProject] = await db
              .insert(projects)
              .values({
                clientId,
                name: row.project,
              })
              .returning({ id: projects.id });
            projectId = newProject.id;
            result.projectsCreated++;
          }
          projectCache.set(projectKey, projectId);
        }

        // Get or create task if present
        let taskId: string | null = null;
        if (row.task) {
          const taskKey = `${projectId}:${row.task}`;
          taskId = taskCache.get(taskKey) || null;

          if (!taskId) {
            const existingTask = await db.query.tasks.findFirst({
              where: and(
                eq(tasks.projectId, projectId),
                eq(tasks.name, row.task)
              ),
            });

            if (existingTask) {
              taskId = existingTask.id;
            } else {
              const [newTask] = await db
                .insert(tasks)
                .values({
                  projectId,
                  name: row.task,
                })
                .returning({ id: tasks.id });
              taskId = newTask.id;
              result.tasksCreated++;
            }
            taskCache.set(taskKey, taskId);
          }
        }

        // Create a unique key for this entry (includes start time for accurate dedup)
        const entryKey = `${row.date}|${row.startTime}|${projectId}|${row.durationMinutes}|${row.description || ""}`;

        // Skip if we've already imported this exact entry in this session
        if (importedEntryKeys.has(entryKey)) {
          result.entriesSkipped++;
          continue;
        }

        try {
          await db.insert(timeEntries).values({
            organizationId: orgId,
            userId,
            clientId,
            projectId,
            taskId,
            description: row.description || null,
            date: row.date,
            durationMinutes: row.durationMinutes,
            isBillableOverride: row.billable ? true : null,
          });
          importedEntryKeys.add(entryKey);
          result.entriesImported++;
        } catch {
          result.entriesSkipped++;
        }
      }
    }

    return result;
  } else if (session.source === "toggl_workspace") {
    // Import from Toggl workspace export (structure only, no time entries)
    const projectMappings = session.projectMappings || [];

    for (const mapping of projectMappings) {
      const clientId = clientNameToId.get(mapping.clientName);
      if (!clientId) continue;

      // Get or create project
      const projectKey = `${clientId}:${mapping.sourceName}`;
      let projectId = projectCache.get(projectKey);

      if (!projectId) {
        const existingProject = await db.query.projects.findFirst({
          where: and(
            eq(projects.clientId, clientId),
            eq(projects.name, mapping.sourceName)
          ),
        });

        if (existingProject) {
          projectId = existingProject.id;
          projectCache.set(projectKey, projectId);
        } else {
          // Convert rate from dollars to cents if present
          const rateInCents = mapping.rate ? Math.round(mapping.rate * 100) : null;

          const [newProject] = await db
            .insert(projects)
            .values({
              clientId,
              name: mapping.sourceName,
              code: mapping.sourceCode,
              rateOverride: rateInCents,
              isBillable: mapping.billable ?? true,
              isArchived: mapping.isArchived || false,
            })
            .returning({ id: projects.id });
          projectId = newProject.id;
          projectCache.set(projectKey, projectId);
          result.projectsCreated++;
        }
      }
    }

    // No time entries to import for workspace export
    return result;
  } else if (session.source === "toggl_api") {
    // Import from Toggl API
    const togglData = JSON.parse(rawData);
    const { token, workspaceId, dateRange } = togglData;

    // Fetch time entries from Toggl
    const { fetchTogglTimeEntries, fetchTogglProjects } = await import(
      "@/lib/integrations/toggl"
    );

    const [togglProjects, togglEntries] = await Promise.all([
      fetchTogglProjects(token, workspaceId),
      fetchTogglTimeEntries(token, {
        startDate: dateRange.from,
        endDate: dateRange.to,
      }),
    ]);

    // Build toggl project ID -> our project ID mapping
    const togglProjectIdMap = new Map<number, string>();
    const togglProjectClientMap = new Map<number, string>(); // togglProjectId -> clientName

    for (const togglProject of togglProjects) {
      // Find client name for this project
      const clientName =
        togglData.preview?.togglClients?.find(
          (c: { id: number; name: string }) => c.id === togglProject.cid
        )?.name || "Unknown";

      togglProjectClientMap.set(togglProject.id, clientName);

      const clientId = clientNameToId.get(clientName);
      if (!clientId) continue;

      // Get or create project
      const projectKey = `${clientId}:${togglProject.name}`;
      let projectId = projectCache.get(projectKey);

      if (!projectId) {
        const existingProject = await db.query.projects.findFirst({
          where: and(
            eq(projects.clientId, clientId),
            eq(projects.name, togglProject.name)
          ),
        });

        if (existingProject) {
          projectId = existingProject.id;
        } else {
          const [newProject] = await db
            .insert(projects)
            .values({
              clientId,
              name: togglProject.name,
              isBillable: togglProject.billable,
              rateOverride: togglProject.rate,
            })
            .returning({ id: projects.id });
          projectId = newProject.id;
          result.projectsCreated++;
        }
        projectCache.set(projectKey, projectId);
      }

      togglProjectIdMap.set(togglProject.id, projectId);
    }

    // Import entries
    for (const entry of togglEntries) {
      if (!entry.pid) {
        result.entriesSkipped++;
        continue;
      }

      const projectId = togglProjectIdMap.get(entry.pid);
      if (!projectId) {
        result.entriesSkipped++;
        continue;
      }

      const clientName = togglProjectClientMap.get(entry.pid);
      const clientId = clientName ? clientNameToId.get(clientName) : null;
      if (!clientId) {
        result.entriesSkipped++;
        continue;
      }

      const durationMinutes = Math.round(entry.duration / 60);
      if (durationMinutes <= 0) {
        result.entriesSkipped++;
        continue;
      }

      const entryDate = entry.start.split("T")[0];
      const description = entry.description || null;

      // Check for duplicate
      const existingEntries = await db.query.timeEntries.findMany({
        where: and(
          eq(timeEntries.organizationId, orgId),
          eq(timeEntries.userId, userId),
          eq(timeEntries.projectId, projectId),
          eq(timeEntries.date, entryDate),
          eq(timeEntries.durationMinutes, durationMinutes)
        ),
      });

      const isDuplicate = existingEntries.some(
        (e) => (e.description || null) === description
      );

      if (isDuplicate) {
        result.entriesSkipped++;
        continue;
      }

      try {
        await db.insert(timeEntries).values({
          organizationId: orgId,
          userId,
          clientId,
          projectId,
          description,
          date: entryDate,
          durationMinutes,
          isBillableOverride: entry.billable ? true : null,
        });
        result.entriesImported++;
      } catch {
        result.entriesSkipped++;
      }
    }
  } else {
    // Import from CSV
    const rows = parseCSVRows(rawData);

    for (const row of rows) {
      // Try direct client name first, then fall back to guessed name
      const clientId = clientNameToId.get(row.clientName) || clientNameToId.get(row.clientGuess);
      if (!clientId) {
        result.entriesSkipped++;
        continue;
      }

      // Get or create project
      const projectKey = `${clientId}:${row.projectName}`;
      let projectId = projectCache.get(projectKey);

      if (!projectId) {
        const existingProject = await db.query.projects.findFirst({
          where: and(
            eq(projects.clientId, clientId),
            eq(projects.name, row.projectName)
          ),
        });

        if (existingProject) {
          projectId = existingProject.id;
        } else {
          // Convert hourly rate from dollars to cents
          const rateInCents = row.hourlyRate ? Math.round(row.hourlyRate * 100) : null;

          const [newProject] = await db
            .insert(projects)
            .values({
              clientId,
              name: row.projectName,
              code: row.projectCode,
              rateOverride: rateInCents,
              isBillable: row.billable,
            })
            .returning({ id: projects.id });
          projectId = newProject.id;
          result.projectsCreated++;
        }
        projectCache.set(projectKey, projectId);
      }

      // Get or create task if there's a task number
      let taskId: string | null = null;
      if (row.taskNumber) {
        const taskKey = `${projectId}:${row.taskNumber}`;
        taskId = taskCache.get(taskKey) || null;

        if (!taskId) {
          const existingTask = await db.query.tasks.findFirst({
            where: and(
              eq(tasks.projectId, projectId),
              eq(tasks.name, row.taskNumber)
            ),
          });

          if (existingTask) {
            taskId = existingTask.id;
          } else {
            const [newTask] = await db
              .insert(tasks)
              .values({
                projectId,
                name: row.taskNumber,
              })
              .returning({ id: tasks.id });
            taskId = newTask.id;
            result.tasksCreated++;
          }
          taskCache.set(taskKey, taskId);
        }
      }

      // Check for duplicate entry
      const description = row.description || null;
      const existingEntries = await db.query.timeEntries.findMany({
        where: and(
          eq(timeEntries.organizationId, orgId),
          eq(timeEntries.userId, userId),
          eq(timeEntries.projectId, projectId),
          eq(timeEntries.date, row.date),
          eq(timeEntries.durationMinutes, row.durationMinutes)
        ),
      });

      const isDuplicate = existingEntries.some(
        (e) => (e.description || null) === description
      );

      if (isDuplicate) {
        result.entriesSkipped++;
        continue;
      }

      // Create the entry
      try {
        await db.insert(timeEntries).values({
          organizationId: orgId,
          userId,
          clientId,
          projectId,
          taskId,
          description: row.description || null,
          date: row.date,
          durationMinutes: row.durationMinutes,
          isBillableOverride: row.billable ? true : null,
        });
        result.entriesImported++;
      } catch {
        result.entriesSkipped++;
      }
    }
  }

  return result;
}

// Parse CSV rows into structured data
function parseCSVRows(csvData: string) {
  const lines = csvData.split("\n");
  const headerLine = lines[0].replace(/^\ufeff/, "");
  const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());

  const rows: Array<{
    description: string;
    billable: boolean;
    durationMinutes: number;
    projectName: string;
    projectCode: string | null;
    taskNumber: string | null;
    clientName: string;
    clientGuess: string;
    hourlyRate: number | null;
    date: string;
  }> = [];

  // Find column indices
  const descIdx = headers.findIndex((h) => h.includes("description"));
  const billableIdx = headers.findIndex((h) => h === "billable");
  const durationIdx = headers.findIndex((h) => h.includes("duration"));
  const projectIdx = headers.findIndex((h) => h === "project");
  const clientIdx = headers.findIndex((h) => h === "client");
  const rateIdx = headers.findIndex((h) => h === "hourly rate");
  const taskIdx = headers.findIndex((h) => h === "task");
  const dateIdx = headers.findIndex((h) =>
    ["start date", "date", "start_date"].some((a) => h.includes(a))
  );

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    if (projectIdx === -1 || dateIdx === -1) continue;

    const rawProject = fields[projectIdx] || "";
    const { projectName, projectCode, taskNumber: taskFromProject, clientGuess } =
      parseProjectField(rawProject);

    // Use direct client name from Client column if available
    const clientName = clientIdx !== -1 ? (fields[clientIdx] || "").trim() : "";

    // Use task from Task column if available, otherwise from project field
    const taskFromColumn = taskIdx !== -1 ? (fields[taskIdx] || "").trim() : "";
    const taskNumber = (taskFromColumn && taskFromColumn !== "-") ? taskFromColumn : taskFromProject;

    // Get hourly rate
    const hourlyRate = rateIdx !== -1 ? parseFloat(fields[rateIdx]) || null : null;

    const durationMinutes = parseDuration(fields[durationIdx] || "0");
    if (durationMinutes <= 0) continue;

    rows.push({
      description: fields[descIdx] || "",
      billable: fields[billableIdx]?.toLowerCase() === "yes",
      durationMinutes,
      projectName,
      projectCode,
      taskNumber,
      clientName,
      clientGuess: clientName || clientGuess, // Prefer direct client name
      hourlyRate,
      date: fields[dateIdx],
    });
  }

  return rows;
}

function parseProjectField(rawProject: string) {
  const parenMatch = rawProject.match(/\(([^)]+)\)\s*$/);
  let projectCode: string | null = null;
  let taskNumber: string | null = null;

  if (parenMatch) {
    const parenContent = parenMatch[1].trim();
    const commaIndex = parenContent.lastIndexOf(",");
    if (commaIndex !== -1) {
      projectCode = parenContent.substring(0, commaIndex).trim();
      taskNumber = parenContent.substring(commaIndex + 1).trim();
    } else {
      projectCode = parenContent;
    }
  }

  const projectName =
    rawProject.replace(/\s*\([^)]*\)\s*$/, "").trim() || "Unknown";
  const clientGuess = projectName.split(" ")[0];

  return { projectName, projectCode, taskNumber, clientGuess };
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseDuration(duration: string): number {
  const parts = duration.split(":");
  if (parts.length !== 3) return 0;

  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parseInt(parts[2], 10) || 0;

  return hours * 60 + minutes + Math.round(seconds / 60);
}

// Parse Toggl time entries CSV rows
// Format: User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags
function parseTogglEntriesRows(csvData: string) {
  const lines = csvData.split("\n");
  const headerLine = lines[0].replace(/^\ufeff/, "");
  const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());

  const clientIdx = headers.findIndex((h) => h === "client");
  const projectIdx = headers.findIndex((h) => h === "project");
  const taskIdx = headers.findIndex((h) => h === "task");
  const descIdx = headers.findIndex((h) => h === "description");
  const billableIdx = headers.findIndex((h) => h === "billable");
  const dateIdx = headers.findIndex((h) => h === "start date");
  const timeIdx = headers.findIndex((h) => h === "start time");
  const durationIdx = headers.findIndex((h) => h === "duration");

  const rows: Array<{
    client: string;
    project: string;
    task: string | null;
    description: string;
    billable: boolean;
    date: string;
    startTime: string;
    durationMinutes: number;
  }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);

    const client = clientIdx !== -1 ? (fields[clientIdx] || "").trim() : "";
    const project = projectIdx !== -1 ? (fields[projectIdx] || "").trim() : "";
    const task = taskIdx !== -1 ? (fields[taskIdx] || "").trim() || null : null;
    const description = descIdx !== -1 ? (fields[descIdx] || "").trim() : "";
    const billable = billableIdx !== -1 ? fields[billableIdx]?.toLowerCase() === "yes" : true;
    const date = dateIdx !== -1 ? (fields[dateIdx] || "").trim() : "";
    const startTime = timeIdx !== -1 ? (fields[timeIdx] || "").trim() : "";
    const duration = durationIdx !== -1 ? (fields[durationIdx] || "").trim() : "";

    const durationMinutes = parseDuration(duration);
    if (durationMinutes <= 0 || !date || !client || !project) continue;

    rows.push({
      client,
      project,
      task,
      description,
      billable,
      date,
      startTime,
      durationMinutes,
    });
  }

  return rows;
}
