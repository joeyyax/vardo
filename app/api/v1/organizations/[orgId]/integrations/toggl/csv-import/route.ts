import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { clients, projects, tasks, timeEntries } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

type CSVRow = {
  description: string;
  billable: boolean;
  durationMinutes: number;
  project: string;
  projectCode: string | null; // e.g., "25-MARKET-503"
  taskNumber: string | null; // e.g., "3" (from "25-MARKET-503, 3")
  date: string;
};

type ProjectMapping = {
  projectName: string;
  clientId: string;
  clientName: string; // For creating new clients
};

/**
 * POST /api/v1/organizations/[orgId]/integrations/toggl/csv-import
 * Import time entries from Toggl CSV export
 *
 * First call with just csvData to get preview
 * Second call with csvData + projectMappings to execute import
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { orgId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { csvData, projectMappings } = body as {
      csvData: string;
      projectMappings?: ProjectMapping[];
    };

    if (!csvData) {
      return NextResponse.json({ error: "CSV data is required" }, { status: 400 });
    }

    // Parse CSV
    const rows = parseCSV(csvData);

    if (rows.length === 0) {
      return NextResponse.json({ error: "No valid entries found in CSV" }, { status: 400 });
    }

    // Get unique projects and their codes/task numbers
    const uniqueProjects = [...new Set(rows.map((r) => r.project))].sort();

    // Map project name -> project code (first one found)
    const projectCodeMap = new Map<string, string | null>();
    // Map project name -> Set of unique task numbers
    const projectTaskNumbersMap = new Map<string, Set<string>>();

    for (const row of rows) {
      // Store project code (use first one found for each project)
      if (!projectCodeMap.has(row.project) && row.projectCode) {
        projectCodeMap.set(row.project, row.projectCode);
      }
      // Collect unique task numbers per project
      if (row.taskNumber) {
        if (!projectTaskNumbersMap.has(row.project)) {
          projectTaskNumbersMap.set(row.project, new Set());
        }
        projectTaskNumbersMap.get(row.project)!.add(row.taskNumber);
      }
    }

    // If no mappings provided, return preview
    if (!projectMappings) {
      // Get existing clients for mapping suggestions
      const existingClients = await db.query.clients.findMany({
        where: eq(clients.organizationId, orgId),
      });

      return NextResponse.json({
        preview: true,
        entryCount: rows.length,
        projects: uniqueProjects,
        existingClients: existingClients.map((c) => ({
          id: c.id,
          name: c.name,
        })),
        dateRange: {
          from: rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date),
          to: rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date),
        },
      });
    }

    // Execute import
    const result = {
      clientsCreated: 0,
      projectsCreated: 0,
      tasksCreated: 0,
      entriesImported: 0,
      entriesSkipped: 0,
      errors: [] as string[],
    };

    // Build project -> client mapping and create clients/projects/tasks as needed
    const projectToClientMap = new Map<string, string>(); // projectName -> clientId
    const projectToProjectIdMap = new Map<string, string>(); // projectName -> projectId
    const taskNumberToTaskIdMap = new Map<string, string>(); // "projectName:taskNumber" -> taskId

    for (const mapping of projectMappings) {
      let clientId = mapping.clientId;

      // Create client if needed (clientId starts with "new:")
      if (clientId.startsWith("new:")) {
        const clientName = mapping.clientName || mapping.projectName.split(" ")[0];

        // Check if client already exists
        const existingClient = await db.query.clients.findFirst({
          where: and(
            eq(clients.organizationId, orgId),
            eq(clients.name, clientName)
          ),
        });

        if (existingClient) {
          clientId = existingClient.id;
        } else {
          const [newClient] = await db.insert(clients).values({
            organizationId: orgId,
            name: clientName,
          }).returning({ id: clients.id });
          clientId = newClient.id;
          result.clientsCreated++;
        }
      }

      projectToClientMap.set(mapping.projectName, clientId);

      // Create or find project (with project code)
      let projectId: string;
      const existingProject = await db.query.projects.findFirst({
        where: and(
          eq(projects.clientId, clientId),
          eq(projects.name, mapping.projectName)
        ),
      });

      if (existingProject) {
        projectId = existingProject.id;
      } else {
        const projectCode = projectCodeMap.get(mapping.projectName) || null;
        const [newProject] = await db.insert(projects).values({
          clientId,
          name: mapping.projectName,
          code: projectCode, // Store the project code (e.g., "25-MARKET-503")
        }).returning({ id: projects.id });
        projectId = newProject.id;
        result.projectsCreated++;
      }
      projectToProjectIdMap.set(mapping.projectName, projectId);

      // Create tasks for each unique task number under this project
      const taskNumbers = projectTaskNumbersMap.get(mapping.projectName);
      if (taskNumbers) {
        for (const taskNumber of taskNumbers) {
          const taskKey = `${mapping.projectName}:${taskNumber}`;

          // Check if task already exists (by name = task number)
          const existingTask = await db.query.tasks.findFirst({
            where: and(
              eq(tasks.projectId, projectId),
              eq(tasks.name, taskNumber)
            ),
          });

          if (existingTask) {
            taskNumberToTaskIdMap.set(taskKey, existingTask.id);
          } else {
            const [newTask] = await db.insert(tasks).values({
              projectId,
              name: taskNumber, // e.g., "3" - user can rename to "Development" later
            }).returning({ id: tasks.id });
            taskNumberToTaskIdMap.set(taskKey, newTask.id);
            result.tasksCreated++;
          }
        }
      }
    }

    // Import entries
    for (const row of rows) {
      const projectId = projectToProjectIdMap.get(row.project);
      const clientId = projectToClientMap.get(row.project);

      if (!projectId || !clientId) {
        result.entriesSkipped++;
        continue;
      }

      // Get taskId if this row has a task number
      let taskId: string | null = null;
      if (row.taskNumber) {
        const taskKey = `${row.project}:${row.taskNumber}`;
        taskId = taskNumberToTaskIdMap.get(taskKey) || null;
      }

      // Check for duplicate
      const description = row.description || null;
      const existingEntries = await db.query.timeEntries.findMany({
        where: and(
          eq(timeEntries.organizationId, orgId),
          eq(timeEntries.userId, session.user.id),
          eq(timeEntries.projectId, projectId),
          eq(timeEntries.date, row.date),
          eq(timeEntries.durationMinutes, row.durationMinutes)
        ),
      });

      const isDuplicate = existingEntries.some((e) => {
        const existingDesc = e.description || null;
        return existingDesc === description;
      });

      if (isDuplicate) {
        result.entriesSkipped++;
        continue;
      }

      try {
        await db.insert(timeEntries).values({
          organizationId: orgId,
          userId: session.user.id,
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

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("Error importing CSV:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
}

function parseCSV(csvData: string): CSVRow[] {
  const lines = csvData.split("\n");
  const rows: CSVRow[] = [];

  // Skip header row, handle BOM
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV with quoted fields
    const fields = parseCSVLine(line);
    if (fields.length < 8) continue;

    const [description, billable, duration, , , project, , startDate] = fields;

    // Parse duration (H:MM:SS or HH:MM:SS)
    const durationMinutes = parseDuration(duration);
    if (durationMinutes <= 0) continue;

    // Extract project code and task number from parentheses
    // Format: "Project Name (PROJECT-CODE, TASK-NUMBER)" or "Project Name (PROJECT-CODE)"
    // e.g., "MoC Marketing Website (25-MARKET-503, 3)" → projectCode: "25-MARKET-503", taskNumber: "3"
    // e.g., "GB Website (25-GB-904)" → projectCode: "25-GB-904", taskNumber: null
    const rawProject = project || "Unknown";
    const parenMatch = rawProject.match(/\(([^)]+)\)\s*$/);
    let projectCode: string | null = null;
    let taskNumber: string | null = null;

    if (parenMatch) {
      const parenContent = parenMatch[1].trim();
      // Check if there's a comma separating project code and task number
      const commaIndex = parenContent.lastIndexOf(",");
      if (commaIndex !== -1) {
        projectCode = parenContent.substring(0, commaIndex).trim();
        taskNumber = parenContent.substring(commaIndex + 1).trim();
      } else {
        projectCode = parenContent;
      }
    }

    const cleanProject = rawProject.replace(/\s*\([^)]*\)\s*$/, "").trim();

    rows.push({
      description: description || "",
      billable: billable?.toLowerCase() === "yes",
      durationMinutes,
      project: cleanProject,
      projectCode,
      taskNumber,
      date: startDate, // YYYY-MM-DD format
    });
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
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
  // Format: H:MM:SS or HH:MM:SS
  const parts = duration.split(":");
  if (parts.length !== 3) return 0;

  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parseInt(parts[2], 10) || 0;

  return hours * 60 + minutes + Math.round(seconds / 60);
}
