/**
 * Toggl Track API integration
 *
 * API docs: https://engineering.toggl.com/docs/
 * Base URL: https://api.track.toggl.com/api/v9
 * Auth: Basic auth with API token as username and "api_token" as password
 */

const TOGGL_API_BASE = "https://api.track.toggl.com/api/v9";

type TogglAuth = {
  token: string;
};

function getAuthHeader(auth: TogglAuth): string {
  // Toggl uses Basic auth with token:api_token
  return `Basic ${Buffer.from(`${auth.token}:api_token`).toString("base64")}`;
}

async function togglFetch<T>(
  auth: TogglAuth,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${TOGGL_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(auth),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Toggl API error (${response.status}): ${text || response.statusText}`
    );
  }

  return response.json();
}

// Types from Toggl API

export type TogglUser = {
  id: number;
  email: string;
  fullname: string;
  default_workspace_id: number;
};

export type TogglWorkspace = {
  id: number;
  name: string;
  organization_id: number;
};

export type TogglClient = {
  id: number;
  wid: number; // workspace id
  name: string;
  archived: boolean;
};

export type TogglProject = {
  id: number;
  wid: number;
  cid: number | null; // client id
  name: string;
  active: boolean;
  color: string;
  billable: boolean;
  rate: number | null; // hourly rate in cents
};

export type TogglTimeEntry = {
  id: number;
  wid: number;
  pid: number | null; // project id
  description: string | null;
  start: string; // ISO date
  stop: string | null;
  duration: number; // seconds (negative if running)
  billable: boolean;
  tags: string[];
};

// API Functions

/**
 * Validate a Toggl API token and get user info
 */
export async function validateTogglToken(
  token: string
): Promise<{ valid: boolean; user?: TogglUser; error?: string }> {
  try {
    // Trim whitespace from token
    const cleanToken = token.trim();
    const user = await togglFetch<TogglUser>({ token: cleanToken }, "/me");
    return { valid: true, user };
  } catch (error) {
    console.error("Toggl token validation failed:", error);
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid token",
    };
  }
}

/**
 * Get all workspaces for the authenticated user
 */
export async function fetchTogglWorkspaces(
  token: string
): Promise<TogglWorkspace[]> {
  return togglFetch<TogglWorkspace[]>({ token }, "/workspaces");
}

/**
 * Get all clients in a workspace
 */
export async function fetchTogglClients(
  token: string,
  workspaceId: number
): Promise<TogglClient[]> {
  try {
    const clients = await togglFetch<TogglClient[]>(
      { token },
      `/workspaces/${workspaceId}/clients`
    );
    return clients.filter((c) => !c.archived);
  } catch {
    // Toggl returns 404 if no clients exist
    return [];
  }
}

/**
 * Get all projects in a workspace
 */
export async function fetchTogglProjects(
  token: string,
  workspaceId: number
): Promise<TogglProject[]> {
  try {
    const projects = await togglFetch<TogglProject[]>(
      { token },
      `/workspaces/${workspaceId}/projects`
    );
    return projects.filter((p) => p.active);
  } catch {
    return [];
  }
}

/**
 * Get time entries for a date range
 * Handles pagination since Toggl API returns max 1000 entries per request.
 * We break the request into monthly chunks to avoid hitting the limit.
 */
export async function fetchTogglTimeEntries(
  token: string,
  options: {
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
  }
): Promise<TogglTimeEntry[]> {
  const { startDate, endDate } = options;
  const allEntries: TogglTimeEntry[] = [];

  // Break into monthly chunks to avoid 1000 entry limit
  const start = new Date(startDate);
  const end = new Date(endDate);
  const currentStart = new Date(start);

  while (currentStart <= end) {
    // Calculate chunk end (1 month later or the final end date)
    const chunkEnd = new Date(currentStart);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    chunkEnd.setDate(chunkEnd.getDate() - 1); // Last day of the month

    const actualEnd = chunkEnd > end ? end : chunkEnd;

    const chunkStartStr = currentStart.toISOString().split("T")[0];
    const chunkEndStr = actualEnd.toISOString().split("T")[0];

    // Toggl uses ISO 8601 format
    const chunkStartISO = `${chunkStartStr}T00:00:00Z`;
    const chunkEndISO = `${chunkEndStr}T23:59:59Z`;

    const entries = await togglFetch<TogglTimeEntry[]>(
      { token },
      `/me/time_entries?start_date=${encodeURIComponent(chunkStartISO)}&end_date=${encodeURIComponent(chunkEndISO)}`
    );

    // Filter out running entries (negative duration) and add to results
    allEntries.push(...entries.filter((e) => e.duration > 0));

    // Move to next month
    currentStart.setMonth(currentStart.getMonth() + 1);
    currentStart.setDate(1);

    // Small delay to respect rate limits
    if (currentStart <= end) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return allEntries;
}

/**
 * Preview import data from Toggl
 */
export type TogglPreviewData = {
  workspace: TogglWorkspace;
  clients: TogglClient[];
  projects: TogglProject[];
  entryCount: number;
  dateRange: {
    from: string;
    to: string;
  };
};

export async function previewTogglImport(
  token: string,
  workspaceId: number,
  dateRange?: { from: string; to: string }
): Promise<TogglPreviewData> {
  const [workspaces, clients, projects] = await Promise.all([
    fetchTogglWorkspaces(token),
    fetchTogglClients(token, workspaceId),
    fetchTogglProjects(token, workspaceId),
  ]);

  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  // Default to 90 days (Toggl API limit)
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 89);
  const from = dateRange?.from || defaultFrom.toISOString().split("T")[0];
  const to = dateRange?.to || now.toISOString().split("T")[0];

  const entries = await fetchTogglTimeEntries(token, {
    startDate: from,
    endDate: to,
  });

  // Filter to only entries in this workspace (by checking project workspace)
  const workspaceProjectIds = new Set(projects.map((p) => p.id));
  const workspaceEntries = entries.filter(
    (e) => !e.pid || workspaceProjectIds.has(e.pid)
  );

  return {
    workspace,
    clients,
    projects,
    entryCount: workspaceEntries.length,
    dateRange: { from, to },
  };
}

// Import mapping types

export type ClientMapping = {
  togglId: number;
  togglName: string;
  action: "create" | "map" | "skip";
  targetClientId?: string; // If mapping to existing client
};

export type ImportResult = {
  clientsCreated: number;
  clientsMapped: number;
  projectsCreated: number;
  entriesImported: number;
  entriesSkipped: number;
  errors: string[];
};
