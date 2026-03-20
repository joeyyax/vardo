import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import TOML from "@iarna/toml";

const TEMPLATES_DIR = resolve(process.cwd(), "templates");

export type Template = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  category: string;
  source: string;
  deployType: string;
  imageName: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  composeContent: string | null;
  rootDirectory: string | null;
  defaultPort: number | null;
  defaultEnvVars:
    | { key: string; description: string; required: boolean; defaultValue?: string }[]
    | null;
  defaultVolumes:
    | { name: string; mountPath: string; description: string }[]
    | null;
  defaultConnectionInfo:
    | { label: string; value: string; copyRef?: string }[]
    | null;
  isBuiltIn: boolean;
};

let cached: Template[] | null = null;

export async function loadTemplates(): Promise<Template[]> {
  if (cached) return cached;

  let files: string[];
  try {
    files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".toml"));
  } catch {
    return [];
  }

  const templates: Template[] = [];

  for (const file of files) {
    try {
      const content = await readFile(join(TEMPLATES_DIR, file), "utf-8");
      const raw = TOML.parse(content) as Record<string, unknown>;

      templates.push({
        id: `builtin-${raw.name as string}`,
        name: raw.name as string,
        displayName: raw.displayName as string,
        description: (raw.description as string) ?? null,
        icon: (raw.icon as string) ?? null,
        category: raw.category as string,
        source: raw.source as string,
        deployType: raw.deployType as string,
        imageName: (raw.imageName as string) ?? null,
        gitUrl: (raw.gitUrl as string) ?? null,
        gitBranch: (raw.gitBranch as string) ?? null,
        composeContent: (raw.composeContent as string) ?? null,
        rootDirectory: (raw.rootDirectory as string) ?? null,
        defaultPort: (raw.defaultPort as number) ?? null,
        defaultEnvVars: (raw.envVars as Template["defaultEnvVars"]) ?? null,
        defaultVolumes: (raw.volumes as Template["defaultVolumes"]) ?? null,
        defaultConnectionInfo: (raw.connectionInfo as Template["defaultConnectionInfo"]) ?? null,
        isBuiltIn: true,
      });
    } catch (err) {
      console.error(`[templates] Failed to load ${file}:`, err);
    }
  }

  // Sort by category then name
  const categoryOrder = ["database", "cache", "monitoring", "web", "tool", "custom"];
  templates.sort((a, b) => {
    const catDiff = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    return a.displayName.localeCompare(b.displayName);
  });

  cached = templates;
  return templates;
}

// Clear cache (for dev hot reload)
export function clearTemplateCache() {
  cached = null;
}
