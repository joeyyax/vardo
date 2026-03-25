import { db } from "@/lib/db";
import { templates } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import TOML from "@iarna/toml";
import { logger } from "@/lib/logger";

const log = logger.child("seed");

const TEMPLATES_DIR = resolve(process.cwd(), "templates");

type TemplateFile = {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  category: string;
  source: string;
  deployType: string;
  imageName?: string;
  gitUrl?: string;
  gitBranch?: string;
  composeContent?: string;
  rootDirectory?: string;
  defaultPort?: number;
  envVars?: { key: string; description: string; required: boolean; defaultValue?: string }[];
  volumes?: { name: string; mountPath: string; description: string }[];
  connectionInfo?: { label: string; value: string; copyRef?: string }[];
};

export async function seedTemplates() {
  let files: string[];
  try {
    files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".toml"));
  } catch {
    log.info("No templates directory found at", TEMPLATES_DIR);
    return;
  }

  log.info(`Found ${files.length} template files`);

  for (const file of files) {
    try {
      const content = await readFile(join(TEMPLATES_DIR, file), "utf-8");
      const tmpl = TOML.parse(content) as unknown as TemplateFile;

      await db
        .insert(templates)
        .values({
          id: nanoid(),
          name: tmpl.name,
          displayName: tmpl.displayName,
          description: tmpl.description ?? null,
          icon: tmpl.icon ?? null,
          category: tmpl.category as "database" | "cache" | "monitoring" | "web" | "tool" | "custom",
          source: tmpl.source as "git" | "direct",
          deployType: tmpl.deployType as "compose" | "dockerfile" | "image" | "static" | "nixpacks",
          imageName: tmpl.imageName ?? null,
          gitUrl: tmpl.gitUrl ?? null,
          gitBranch: tmpl.gitBranch ?? null,
          composeContent: tmpl.composeContent ?? null,
          rootDirectory: tmpl.rootDirectory ?? null,
          defaultPort: tmpl.defaultPort ?? null,
          defaultEnvVars: tmpl.envVars ?? null,
          defaultVolumes: tmpl.volumes ?? null,
          defaultConnectionInfo: tmpl.connectionInfo ?? null,
          isBuiltIn: true,
        })
        .onConflictDoUpdate({
          target: templates.name,
          set: {
            displayName: tmpl.displayName,
            description: tmpl.description ?? null,
            icon: tmpl.icon ?? null,
            category: tmpl.category as "database" | "cache" | "monitoring" | "web" | "tool" | "custom",
            source: tmpl.source as "git" | "direct",
            deployType: tmpl.deployType as "compose" | "dockerfile" | "image" | "static" | "nixpacks",
            imageName: tmpl.imageName ?? null,
            gitUrl: tmpl.gitUrl ?? null,
            gitBranch: tmpl.gitBranch ?? null,
            composeContent: tmpl.composeContent ?? null,
            defaultPort: tmpl.defaultPort ?? null,
            defaultEnvVars: tmpl.envVars ?? null,
            defaultVolumes: tmpl.volumes ?? null,
            defaultConnectionInfo: tmpl.connectionInfo ?? null,
            updatedAt: new Date(),
          },
        });

      log.info(`${tmpl.name} done`);
    } catch (err) {
      log.error(`Failed to process ${file}:`, err);
    }
  }
}
