import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { importSessions, clients } from "@/lib/db/schema";
import { and, eq, desc } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

/**
 * GET /api/v1/organizations/[orgId]/imports
 * List import sessions (for resuming)
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { orgId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sessions = await db.query.importSessions.findMany({
      where: and(
        eq(importSessions.organizationId, orgId),
        eq(importSessions.userId, session.user.id),
        eq(importSessions.status, "in_progress")
      ),
      orderBy: [desc(importSessions.updatedAt)],
    });

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("Error fetching import sessions:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch imports" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/organizations/[orgId]/imports
 * Create a new import session
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { orgId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { source, rawData } = body as {
      source: string;
      rawData: string;
    };

    if (!source || !rawData) {
      return NextResponse.json(
        { error: "source and rawData are required" },
        { status: 400 }
      );
    }

    // Get existing clients for matching
    const existingClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
    });

    let clientMappings: ReturnType<typeof generateClientMappings>;
    let projectMappings: Array<{
      sourceName: string;
      sourceCode: string | null;
      clientName: string;
      startDate?: string | null;
      estimateHours?: number | null;
      rate?: number | null;
      color?: string | null;
      billable?: boolean;
      actualHours?: number | null;
      isArchived?: boolean;
      togglId?: number;
      confirmed: boolean;
    }>;
    let totalRows: number;
    let columnMapping: Record<string, string> | undefined;
    let dateRange: { from: string; to: string };

    if (source === "toggl_combined") {
      // Combined import: workspace data (zip) + time entries (CSV)
      const combinedData = JSON.parse(rawData);
      const workspace = combinedData.workspace;
      const entriesCsv = combinedData.entries;

      // Parse workspace data if present
      const togglClients: TogglWorkspaceClient[] = workspace?.clients || [];
      const togglProjects: TogglWorkspaceProject[] = workspace?.projects || [];

      // Parse entries CSV if present
      let entriesParseResult: { rowCount: number; uniqueClients: string[]; dateRange: { from: string; to: string } } | null = null;
      if (entriesCsv) {
        const parsed = parseTogglEntriesCSV(entriesCsv);
        if (!("error" in parsed)) {
          entriesParseResult = parsed;
        }
      }

      // Combine client names from both sources
      const workspaceClientNames = togglClients.map((c) => c.name);
      const entriesClientNames = entriesParseResult?.uniqueClients || [];
      const allClientNames = [...new Set([...workspaceClientNames, ...entriesClientNames])];

      clientMappings = generateClientMappings(allClientNames, existingClients);

      // Build project mappings from workspace export
      projectMappings = togglProjects.map((p) => {
        const client = togglClients.find((c) => c.id === p.client_id);

        let estimateHours: number | null = null;
        if (p.estimated_seconds) {
          estimateHours = Math.round((p.estimated_seconds / 3600) * 10) / 10;
        }

        return {
          sourceName: p.name,
          sourceCode: null,
          clientName: client?.name || "No Client",
          startDate: p.start_date || null,
          estimateHours,
          rate: p.rate || null,
          color: p.color || null,
          billable: p.billable ?? true,
          actualHours: p.actual_hours || null,
          isArchived: p.status === "archived" || !p.active,
          togglId: p.id,
          confirmed: false,
        };
      });

      // Count entries from CSV
      totalRows = entriesParseResult?.rowCount || 0;
      dateRange = entriesParseResult?.dateRange || { from: "", to: "" };
    } else if (source === "toggl_workspace") {
      // Parse Toggl workspace export (JSON format from Settings > Data Export)
      const workspaceData = JSON.parse(rawData);
      const togglClients: TogglWorkspaceClient[] = workspaceData.clients || [];
      const togglProjects: TogglWorkspaceProject[] = workspaceData.projects || [];

      // Extract unique client names
      const uniqueClients = togglClients.map((c) => c.name);

      clientMappings = generateClientMappings(uniqueClients, existingClients);

      // Build project mappings with full metadata from workspace export
      projectMappings = togglProjects.map((p) => {
        const client = togglClients.find((c) => c.id === p.client_id);

        // Parse estimate from seconds to hours
        let estimateHours: number | null = null;
        if (p.estimated_seconds) {
          estimateHours = Math.round((p.estimated_seconds / 3600) * 10) / 10;
        }

        return {
          sourceName: p.name,
          sourceCode: null,
          clientName: client?.name || "No Client",
          startDate: p.start_date || null,
          estimateHours,
          rate: p.rate || null, // Already in dollars from Toggl
          color: p.color || null,
          billable: p.billable ?? true,
          actualHours: p.actual_hours || null,
          isArchived: p.status === "archived" || !p.active,
          togglId: p.id, // Preserve for reference
          confirmed: false,
        };
      });

      // No time entries in workspace export - just structure
      totalRows = 0;
      dateRange = { from: "", to: "" };
    } else if (source === "toggl_api") {
      // Parse Toggl API data
      const togglData = JSON.parse(rawData);
      const preview = togglData.preview;

      // Extract unique client names from Toggl clients
      const uniqueClients = (preview.togglClients || []).map(
        (c: { name: string }) => c.name
      );

      clientMappings = generateClientMappings(uniqueClients, existingClients);

      // Use suggested mappings from preview to improve confidence
      for (const suggested of preview.suggestedMappings || []) {
        const mapping = clientMappings.find(
          (m) => m.sourceName === suggested.togglName
        );
        if (mapping && suggested.suggestedAction === "map" && suggested.suggestedTargetId) {
          mapping.targetId = suggested.suggestedTargetId;
          mapping.targetName = suggested.suggestedTargetName || mapping.targetName;
          mapping.confidence = 1.0;
          mapping.confirmed = true;
        }
      }

      // Build project mappings from Toggl projects
      const togglClients = preview.togglClients || [];
      projectMappings = (preview.togglProjects || []).map(
        (p: { name: string; clientId?: number }) => {
          const client = togglClients.find(
            (c: { id: number; name: string }) => c.id === p.clientId
          );
          return {
            sourceName: p.name,
            sourceCode: null,
            clientName: client?.name || "Unknown",
            confirmed: false,
          };
        }
      );

      totalRows = preview.counts?.entries || 0;
      dateRange = preview.dateRange || togglData.dateRange;
    } else {
      // Parse CSV data
      const parseResult = parseCSVForImport(rawData);

      if (parseResult.error) {
        return NextResponse.json({ error: parseResult.error }, { status: 400 });
      }

      clientMappings = generateClientMappings(
        parseResult.uniqueClients || [],
        existingClients
      );

      const projects = parseResult.projects || [];
      projectMappings = projects.map((p) => ({
        sourceName: p.name,
        sourceCode: p.code,
        clientName: p.clientName,
        startDate: p.startDate,
        estimateHours: p.estimateHours,
        rate: p.rate,
        confirmed: false,
      }));

      totalRows = parseResult.rowCount || 0;
      columnMapping = parseResult.columnMapping;
      dateRange = parseResult.dateRange || { from: "", to: "" };
    }

    // Create the import session
    const [importSession] = await db
      .insert(importSessions)
      .values({
        organizationId: orgId,
        userId: session.user.id,
        source,
        currentStep: "clients", // Start at client mapping
        rawData,
        columnMapping,
        clientMappings,
        projectMappings,
        totalRows,
      })
      .returning();

    // Calculate if we can auto-advance (all clients have high confidence)
    const needsClientReview = clientMappings.some(
      (m) => m.confidence < 0.8 && !m.confirmed
    );

    return NextResponse.json({
      session: importSession,
      needsClientReview,
      summary: {
        rowCount: totalRows,
        clientCount: clientMappings.length,
        projectCount: projectMappings.length,
        dateRange,
      },
    });
  } catch (error) {
    console.error("Error creating import session:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create import" },
      { status: 500 }
    );
  }
}

// CSV parsing helper
function parseCSVForImport(csvData: string) {
  const lines = csvData.split("\n");
  if (lines.length < 2) {
    return { error: "CSV must have at least a header and one data row" };
  }

  // Parse header
  const headerLine = lines[0].replace(/^\ufeff/, ""); // Remove BOM
  const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());

  // Detect column mapping - expanded for full Toggl export
  const columnMapping: Record<string, string> = {};
  const knownColumns = {
    description: ["description", "desc", "notes"],
    billable: ["billable", "is_billable", "billed"],
    duration: ["duration", "time", "hours"],
    project: ["project", "project name"],
    date: ["start date", "date", "start_date", "startdate"],
    client: ["client", "client name"],
    task: ["task", "task name"],
    hourlyRate: ["hourly rate", "rate", "hourly_rate"],
    projectStart: ["project start", "project_start"],
    projectEstimate: ["project estimate", "project_estimate", "estimate"],
  };

  for (const [field, aliases] of Object.entries(knownColumns)) {
    const index = headers.findIndex((h) =>
      aliases.some((a) => h.includes(a))
    );
    if (index !== -1) {
      columnMapping[field] = headers[index];
    }
  }

  // Get column indices
  const clientIndex = headers.findIndex((h) => h === "client");
  const projectIndex = headers.findIndex((h) => h === "project");
  const dateIndex = headers.findIndex((h) => h === "start date");
  const hourlyRateIndex = headers.findIndex((h) => h === "hourly rate");
  const projectStartIndex = headers.findIndex((h) => h === "project start");
  const projectEstimateIndex = headers.findIndex((h) => h === "project estimate");
  const billableIndex = headers.findIndex((h) => h === "billable");

  // Parse rows
  const uniqueClientsMap = new Map<string, { rate: number | null }>(); // clientName -> rate
  const projectsMap = new Map<string, {
    name: string;
    code: string | null;
    clientName: string;
    startDate: string | null;
    estimateHours: number | null;
    rate: number | null;
  }>();
  let minDate = "";
  let maxDate = "";
  let rowCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);

    // Get client directly from Client column if available
    const clientName = clientIndex !== -1 ? (fields[clientIndex] || "").trim() : "";
    const rawProject = projectIndex !== -1 ? (fields[projectIndex] || "").trim() : "";
    const date = dateIndex !== -1 ? (fields[dateIndex] || "").trim() : "";
    const hourlyRate = hourlyRateIndex !== -1 ? parseFloat(fields[hourlyRateIndex]) || null : null;
    const projectStart = projectStartIndex !== -1 ? (fields[projectStartIndex] || "").trim() : null;
    const projectEstimateRaw = projectEstimateIndex !== -1 ? (fields[projectEstimateIndex] || "").trim() : null;
    const billable = billableIndex !== -1 ? fields[billableIndex]?.toLowerCase() === "yes" : true;

    // Parse project estimate (format: "50:00:00" = 50 hours)
    let estimateHours: number | null = null;
    if (projectEstimateRaw && projectEstimateRaw !== "-") {
      const match = projectEstimateRaw.match(/^(\d+):(\d+):(\d+)$/);
      if (match) {
        estimateHours = parseInt(match[1]) + parseInt(match[2]) / 60;
      }
    }

    // Extract project name and code
    const { projectName, projectCode } = parseProjectField(rawProject);

    // Use actual client name from CSV, fall back to guessing from project
    const finalClientName = clientName || projectName.split(" ")[0] || "Unknown";

    if (finalClientName && finalClientName !== "-") {
      if (!uniqueClientsMap.has(finalClientName)) {
        uniqueClientsMap.set(finalClientName, { rate: hourlyRate });
      }
    }

    if (projectName && projectName !== "-") {
      const projectKey = `${finalClientName}:${projectName}`;
      if (!projectsMap.has(projectKey)) {
        projectsMap.set(projectKey, {
          name: projectName,
          code: projectCode,
          clientName: finalClientName,
          startDate: projectStart && projectStart !== "-" ? projectStart : null,
          estimateHours,
          rate: hourlyRate,
        });
      }
    }

    // Track date range
    if (date && date !== "-") {
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    }

    rowCount++;
  }

  return {
    columnMapping,
    uniqueClients: Array.from(uniqueClientsMap.keys()),
    clientRates: Object.fromEntries(uniqueClientsMap),
    projects: Array.from(projectsMap.values()),
    rowCount,
    dateRange: { from: minDate, to: maxDate },
  };
}

function parseProjectField(rawProject: string) {
  // Format: "Project Name (CODE, TASK)" or "Project Name (CODE)"
  const parenMatch = rawProject.match(/\(([^)]+)\)\s*$/);
  let projectCode: string | null = null;

  if (parenMatch) {
    const parenContent = parenMatch[1].trim();
    const commaIndex = parenContent.lastIndexOf(",");
    if (commaIndex !== -1) {
      projectCode = parenContent.substring(0, commaIndex).trim();
    } else {
      projectCode = parenContent;
    }
  }

  const projectName = rawProject.replace(/\s*\([^)]*\)\s*$/, "").trim() || "Unknown";

  // Guess client from first word of project name
  const clientGuess = projectName.split(" ")[0];

  return { projectName, projectCode, clientGuess };
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

type ExistingClient = { id: string; name: string };

// Parse Toggl's time entries export CSV format
// Format: User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags
function parseTogglEntriesCSV(csvData: string) {
  const lines = csvData.split("\n");
  if (lines.length < 2) {
    return { error: "CSV must have at least a header and one data row", rowCount: 0, uniqueClients: [], dateRange: { from: "", to: "" } };
  }

  const headerLine = lines[0].replace(/^\ufeff/, "");
  const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());

  // Find column indices
  const clientIdx = headers.findIndex((h) => h === "client");
  const projectIdx = headers.findIndex((h) => h === "project");
  const taskIdx = headers.findIndex((h) => h === "task");
  const descIdx = headers.findIndex((h) => h === "description");
  const billableIdx = headers.findIndex((h) => h === "billable");
  const dateIdx = headers.findIndex((h) => h === "start date");
  const durationIdx = headers.findIndex((h) => h === "duration");

  const uniqueClientsSet = new Set<string>();
  let minDate = "";
  let maxDate = "";
  let rowCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);

    const client = clientIdx !== -1 ? (fields[clientIdx] || "").trim() : "";
    const date = dateIdx !== -1 ? (fields[dateIdx] || "").trim() : "";

    if (client) {
      uniqueClientsSet.add(client);
    }

    if (date) {
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    }

    rowCount++;
  }

  return {
    rowCount,
    uniqueClients: Array.from(uniqueClientsSet),
    dateRange: { from: minDate, to: maxDate },
  };
}

// Toggl workspace export types
interface TogglWorkspaceClient {
  id: number;
  name: string;
  archived: boolean;
}

interface TogglWorkspaceProject {
  id: number;
  name: string;
  client_id: number | null;
  client_name: string | null;
  billable: boolean;
  rate: number | null;
  color: string;
  start_date: string | null;
  actual_hours: number | null;
  actual_seconds: number | null;
  estimated_hours: number | null;
  estimated_seconds: number | null;
  active: boolean;
  status: "active" | "archived";
}

function generateClientMappings(
  sourceClients: string[],
  existingClients: ExistingClient[]
) {
  return sourceClients.map((sourceName) => {
    // Try to find exact match
    const exactMatch = existingClients.find(
      (c) => c.name.toLowerCase() === sourceName.toLowerCase()
    );
    if (exactMatch) {
      return {
        sourceName,
        targetId: exactMatch.id,
        targetName: exactMatch.name,
        confidence: 1.0,
        confirmed: true, // Auto-confirm exact matches
      };
    }

    // Try to find partial match
    const partialMatch = existingClients.find(
      (c) =>
        c.name.toLowerCase().includes(sourceName.toLowerCase()) ||
        sourceName.toLowerCase().includes(c.name.toLowerCase())
    );
    if (partialMatch) {
      return {
        sourceName,
        targetId: partialMatch.id,
        targetName: partialMatch.name,
        confidence: 0.7,
        confirmed: false,
      };
    }

    // No match - suggest creating new
    return {
      sourceName,
      targetId: null,
      targetName: sourceName,
      confidence: 0.5,
      confirmed: false,
    };
  });
}
