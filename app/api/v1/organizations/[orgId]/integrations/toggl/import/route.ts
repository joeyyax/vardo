import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import {
  fetchTogglClients,
  fetchTogglProjects,
  fetchTogglTimeEntries,
  type ImportResult,
  type ClientMapping,
} from "@/lib/integrations/toggl";
import { db } from "@/lib/db";
import { clients, projects, timeEntries } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

/**
 * POST /api/v1/organizations/[orgId]/integrations/toggl/import
 * Execute the Toggl import with provided mappings
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { orgId } = await context.params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const {
      token,
      workspaceId,
      dateRange,
      clientMappings,
    }: {
      token: string;
      workspaceId: number;
      dateRange: { from: string; to: string };
      clientMappings: ClientMapping[];
    } = body;

    if (!token || !workspaceId || !clientMappings) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const result: ImportResult = {
      clientsCreated: 0,
      clientsMapped: 0,
      projectsCreated: 0,
      entriesImported: 0,
      entriesSkipped: 0,
      errors: [],
    };

    // Fetch Toggl data
    const [togglClients, togglProjects, togglEntries] = await Promise.all([
      fetchTogglClients(token, workspaceId),
      fetchTogglProjects(token, workspaceId),
      fetchTogglTimeEntries(token, {
        startDate: dateRange.from,
        endDate: dateRange.to,
      }),
    ]);

    // Create a mapping from Toggl client ID to our client ID
    const clientIdMap = new Map<number, string>();

    // Process client mappings
    for (const mapping of clientMappings) {
      if (mapping.action === "skip") {
        continue;
      }

      if (mapping.action === "map" && mapping.targetClientId) {
        clientIdMap.set(mapping.togglId, mapping.targetClientId);
        result.clientsMapped++;
        continue;
      }

      if (mapping.action === "create") {
        const togglClient = togglClients.find((c) => c.id === mapping.togglId);
        if (!togglClient) continue;

        try {
          // Check if client already exists with this name
          const existingClient = await db.query.clients.findFirst({
            where: and(
              eq(clients.organizationId, orgId),
              eq(clients.name, togglClient.name)
            ),
          });

          if (existingClient) {
            // Use existing client
            clientIdMap.set(mapping.togglId, existingClient.id);
            result.clientsMapped++;
            continue;
          }

          const [newClient] = await db.insert(clients).values({
            organizationId: orgId,
            name: togglClient.name,
          }).returning({ id: clients.id });

          clientIdMap.set(mapping.togglId, newClient.id);
          result.clientsCreated++;
        } catch (err) {
          result.errors.push(`Failed to create client: ${togglClient.name}`);
        }
      }
    }

    // Create a mapping from Toggl project ID to our project ID
    // Also track which client each project belongs to
    const projectIdMap = new Map<number, string>();
    const projectClientMap = new Map<string, string>(); // projectId -> clientId

    // Process projects
    for (const togglProject of togglProjects) {
      // Find the client this project belongs to
      let clientId: string | undefined;

      if (togglProject.cid) {
        clientId = clientIdMap.get(togglProject.cid);
        if (!clientId) {
          // Client was skipped, skip project too
          continue;
        }
      } else {
        // Project without client - skip for now
        continue;
      }

      try {
        // Check if project already exists for this client
        const existingProject = await db.query.projects.findFirst({
          where: and(
            eq(projects.clientId, clientId),
            eq(projects.name, togglProject.name)
          ),
        });

        if (existingProject) {
          // Use existing project
          projectIdMap.set(togglProject.id, existingProject.id);
          projectClientMap.set(existingProject.id, clientId);
          continue;
        }

        const [newProject] = await db.insert(projects).values({
          clientId,
          name: togglProject.name,
          isBillable: togglProject.billable,
          rateOverride: togglProject.rate, // Toggl rate is in cents
        }).returning({ id: projects.id });

        projectIdMap.set(togglProject.id, newProject.id);
        projectClientMap.set(newProject.id, clientId);
        result.projectsCreated++;
      } catch (err) {
        result.errors.push(`Failed to create project: ${togglProject.name}`);
      }
    }

    // Process time entries
    for (const entry of togglEntries) {
      // Find project mapping
      let projectId: string | undefined;
      let clientId: string | undefined;

      if (entry.pid) {
        projectId = projectIdMap.get(entry.pid);
        if (!projectId) {
          // Project was skipped
          result.entriesSkipped++;
          continue;
        }
        clientId = projectClientMap.get(projectId);
        if (!clientId) {
          result.entriesSkipped++;
          continue;
        }
      } else {
        // Entry without project - skip
        result.entriesSkipped++;
        continue;
      }

      try {
        // Convert duration from seconds to minutes
        const durationMinutes = Math.round(entry.duration / 60);
        if (durationMinutes <= 0) {
          result.entriesSkipped++;
          continue;
        }

        // Parse the date
        const entryDate = entry.start.split("T")[0]; // YYYY-MM-DD

        // Check for duplicate entry (same date, project, duration, description)
        const description = entry.description || null;
        const existingEntries = await db.query.timeEntries.findMany({
          where: and(
            eq(timeEntries.organizationId, orgId),
            eq(timeEntries.userId, session.user.id),
            eq(timeEntries.projectId, projectId),
            eq(timeEntries.date, entryDate),
            eq(timeEntries.durationMinutes, durationMinutes)
          ),
        });

        // Check if any existing entry has matching description
        const isDuplicate = existingEntries.some((e) => {
          const existingDesc = e.description || null;
          return existingDesc === description;
        });

        if (isDuplicate) {
          result.entriesSkipped++;
          continue;
        }

        await db.insert(timeEntries).values({
          organizationId: orgId,
          userId: session.user.id,
          clientId,
          projectId,
          description: entry.description,
          date: entryDate,
          durationMinutes,
          isBillableOverride: entry.billable ? true : null,
        });
        result.entriesImported++;
      } catch (err) {
        result.entriesSkipped++;
        // Don't log every entry error
      }
    }

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error importing from Toggl:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
}
