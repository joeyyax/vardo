#!/usr/bin/env tsx
/**
 * Vardo Adopt CLI
 *
 * Onboards an existing local directory into Vardo as a `local` environment.
 *
 * Usage:
 *   tsx scripts/adopt-cli.ts <path> [options]
 *   vardo adopt <path> [options]  (via wrapper script)
 */

import { readFile, access } from "fs/promises";
import { resolve, basename } from "path";
import YAML from "yaml";

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
Vardo Adopt — Onboard existing repos with vardo.yaml

Usage:
  tsx scripts/adopt-cli.ts <path> [options]
  vardo adopt <path> [options]

Arguments:
  path              Filesystem path to project directory containing docker-compose.yml

Options:
  --name            App slug (lowercase, hyphens). Defaults to directory name.
  --display         Human-readable app name. Defaults to directory name.
  --domain          Custom domain. Defaults to <name>.localhost.
  --port            Primary container port. Default: 3000.
  --project         Link to existing project ID.
  --new-project     Create a new project with this name.
  --env             Environment type: local, production, staging, preview. Default: local.
  --api-url         Vardo API URL. Default: http://localhost:3000.
  --api-key         API key for authentication (or set VARDO_API_KEY).
  --org             Organization ID (auto-detected from API if not provided).

Examples:
  tsx scripts/adopt-cli.ts ./my-app
  tsx scripts/adopt-cli.ts ./my-app --name my-app --domain myapp.example.com
  tsx scripts/adopt-cli.ts ./my-app --new-project "My App" --env local
`);
}

function parseArgs(args: string[]): {
  path?: string;
  name?: string;
  display?: string;
  domain?: string;
  port?: number;
  project?: string;
  newProject?: string;
  env?: string;
  apiUrl?: string;
  apiKey?: string;
  org?: string;
  help?: boolean;
} {
  const result: Record<string, string | number | boolean | undefined> = {} as Record<string, string | number | boolean | undefined>;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        if (key === "port") {
          result[key] = parseInt(value, 10);
        } else {
          result[key] = value;
        }
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else if (!result.path) {
      result.path = arg;
      i++;
    } else {
      i++;
    }
  }

  return result as {
    path?: string;
    name?: string;
    display?: string;
    domain?: string;
    port?: number;
    project?: string;
    newProject?: string;
    env?: string;
    apiUrl?: string;
    apiKey?: string;
    org?: string;
    help?: boolean;
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface VardoConfig {
  project?: {
    name?: string;
    environments?: Record<
      string,
      {
        domain?: string;
        exclude?: string[];
      }
    >;
    env?: string[];
    resources?: {
      memory?: string;
      cpus?: string;
    };
  };
}

async function readVardoConfig(dir: string): Promise<VardoConfig["project"] | null> {
  const configPath = resolve(dir, "vardo.yml");
  if (!(await fileExists(configPath))) {
    return null;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const config = YAML.parse(content) as VardoConfig;
    return config.project ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const parsed = parseArgs(args);

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  if (!parsed.path) {
    console.error("Error: Path is required");
    printUsage();
    process.exit(1);
  }

  const projectPath = resolve(parsed.path);
  const composePath = resolve(projectPath, "docker-compose.yml");

  // Check docker-compose.yml exists
  if (!(await fileExists(composePath))) {
    console.error(`Error: No docker-compose.yml found at ${composePath}`);
    process.exit(1);
  }

  // Read optional vardo.yml
  const projectConfig = await readVardoConfig(projectPath);

  // Derive defaults from directory name
  const dirName = basename(projectPath);
  const name = (parsed.name || dirName).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const displayName = parsed.display || dirName;

  // Read compose content
  const composeContent = await readFile(composePath, "utf-8");

  // Build request body
  const body: {
    composeContent: string;
    name: string;
    displayName: string;
    environmentType: string;
    projectConfig?: VardoConfig["project"];
    domain?: string;
    containerPort?: number;
    projectId?: string;
    newProjectName?: string;
  } = {
    composeContent,
    name,
    displayName,
    environmentType: parsed.env || "local",
  };

  // Add project config from vardo.yml if present
  if (projectConfig) {
    body.projectConfig = projectConfig;
  }

  // Override with CLI options
  if (parsed.domain) {
    body.domain = parsed.domain;
  }
  if (parsed.port) {
    body.containerPort = parsed.port;
  }
  if (parsed.project) {
    body.projectId = parsed.project;
  }
  if (parsed.newProject) {
    body.newProjectName = parsed.newProject;
  }

  const apiUrl = parsed.apiUrl || process.env.VARDO_API_URL || "http://localhost:3000";
  const apiKey = parsed.apiKey || process.env.VARDO_API_KEY;

  if (!apiKey) {
    console.error("Error: API key is required. Set --api-key or VARDO_API_KEY environment variable.");
    console.error("Generate an API key in Vardo dashboard: Settings → API Keys");
    process.exit(1);
  }

  console.log(`Adopting project from: ${projectPath}`);
  console.log(`  Name: ${name}`);
  console.log(`  Display: ${displayName}`);
  console.log(`  Environment: ${body.environmentType}`);
  if (projectConfig?.environments?.[body.environmentType]?.exclude) {
    console.log(`  Excluded services: ${projectConfig.environments?.[body.environmentType]?.exclude?.join(", ")}`);
  }
  console.log(`  API URL: ${apiUrl}`);

  // First, fetch the organization list to get the org ID
  console.log("\nFetching organization info...");

  let orgId = parsed.org;

  if (!orgId) {
    try {
      const orgRes = await fetch(`${apiUrl}/api/v1/organizations`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!orgRes.ok) {
        if (orgRes.status === 401) {
          console.error("Error: Invalid API key");
          process.exit(1);
        }
        throw new Error(`Failed to fetch organizations: ${orgRes.status} ${orgRes.statusText}`);
      }

      const orgData = await orgRes.json();
      const orgs = orgData.organizations || [];

      if (orgs.length === 0) {
        console.error("Error: No organizations found. Create an organization first.");
        process.exit(1);
      }

      // Use the first organization the user belongs to
      orgId = orgs[0].id;
      console.log(`  Organization: ${orgs[0].name} (${orgId})`);
    } catch (err) {
      console.error(`Error fetching organizations: ${err}`);
      process.exit(1);
    }
  }

  // POST to adopt endpoint
  console.log("\nAdopting project...");

  try {
    const res = await fetch(`${apiUrl}/api/v1/organizations/${orgId}/adopt`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409 && data.appId) {
        console.error(`Error: An app with this slug already exists (ID: ${data.appId})`);
      } else {
        console.error(`Error: ${data.error || res.statusText}`);
      }
      process.exit(1);
    }

    console.log("\nSuccess!");
    console.log(`  App ID: ${data.app.id}`);
    console.log(`  Environment: ${data.environmentType}`);
    console.log(`  Domain: ${data.domain}`);
    console.log(`\nDashboard: ${apiUrl}/apps/${data.app.id}`);
  } catch (err) {
    console.error(`Error adopting project: ${err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
