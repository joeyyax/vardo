// Shared between the new-app form and its regression test: the form state a
// template produces, and the create-app request body that state submits.

import type { Template } from "./load";
import { isSecretKey } from "@/lib/env/is-secret-key";
import { parseEnvContent } from "@/lib/env/parse-env-content";
import { slugify } from "@/lib/ui/slugify";

const GIB = 1_073_741_824;

/** Categories that get no public URL. */
const NO_URL_CATEGORIES = ["database", "cache"];

/** Categories whose data must survive a redeploy. */
const ALWAYS_PERSIST_CATEGORIES = ["database", "cache", "monitoring", "tool"];

export type AppSource = "git" | "direct";
export type AppDeployType =
  | "compose"
  | "dockerfile"
  | "image"
  | "static"
  | "nixpacks"
  | "railpack";

export type AppFormState = {
  displayName: string;
  name: string;
  description: string;
  source: AppSource;
  deployType: AppDeployType;
  gitUrl: string;
  gitBranch: string;
  imageName: string;
  composeContent: string;
  composeFilePath: string;
  dockerfilePath: string;
  rootDirectory: string;
  containerPort: string;
  cpuLimit: string;
  memoryLimit: string;
  diskWriteAlertThreshold: string;
  autoDeploy: boolean;
  generateDomain: boolean;
  persistData: boolean;
  exposePort: boolean;
  volumes: { name: string; mountPath: string; description: string }[];
  connectionInfo: { label: string; value: string; copyRef?: string }[];
  projectId: string;
  templateName?: string;
};

export function generatePassword(length = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** Form state a template fills in when it is selected. */
export function templateFormState(template: Template, name: string): AppFormState {
  return {
    displayName: template.displayName,
    name,
    description: template.description || "",
    source: template.source as AppSource,
    deployType: template.deployType as AppDeployType,
    gitUrl: template.gitUrl || "",
    gitBranch: template.gitBranch || "main",
    imageName: template.imageName || "",
    composeContent: template.composeContent || "",
    composeFilePath: "docker-compose.yml",
    dockerfilePath: "Dockerfile",
    rootDirectory: template.rootDirectory || "",
    containerPort: template.defaultPort?.toString() || "",
    cpuLimit: template.defaultCpuLimit?.toString() || "",
    memoryLimit: template.defaultMemoryLimit?.toString() || "",
    diskWriteAlertThreshold: template.defaultDiskWriteAlertThreshold
      ? (template.defaultDiskWriteAlertThreshold / GIB).toString()
      : "",
    autoDeploy: true,
    generateDomain: !NO_URL_CATEGORIES.includes(template.category),
    persistData: ALWAYS_PERSIST_CATEGORIES.includes(template.category),
    exposePort: false,
    volumes: template.defaultVolumes || [],
    connectionInfo: template.defaultConnectionInfo || [],
    projectId: "",
    templateName: template.name,
  };
}

/** Request body for POST /organizations/[orgId]/apps. */
export function buildCreateAppBody(form: AppFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: form.displayName.trim(),
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    source: form.source,
    deployType: form.deployType,
    templateName: form.templateName || undefined,
    autoTraefikLabels: true,
    autoDeploy: form.autoDeploy,
    generateDomain: form.generateDomain,
    projectId: form.projectId,
    persistentVolumes:
      form.persistData && form.volumes.length > 0
        ? form.volumes.map((v) => ({ name: v.name, mountPath: v.mountPath }))
        : undefined,
    connectionInfo: form.connectionInfo.length > 0 ? form.connectionInfo : undefined,
    exposedPorts:
      form.exposePort && form.containerPort
        ? [{ internal: parseInt(form.containerPort, 10), description: "Primary port" }]
        : undefined,
  };

  if (form.containerPort) body.containerPort = parseInt(form.containerPort, 10);
  if (form.cpuLimit) body.cpuLimit = parseFloat(form.cpuLimit);
  if (form.memoryLimit) body.memoryLimit = parseInt(form.memoryLimit, 10);
  if (form.diskWriteAlertThreshold) {
    body.diskWriteAlertThreshold = Math.round(parseFloat(form.diskWriteAlertThreshold) * GIB);
  }
  if (form.rootDirectory.trim()) body.rootDirectory = form.rootDirectory.trim();
  if (form.source === "git") {
    body.gitUrl = form.gitUrl.trim();
    body.gitBranch = form.gitBranch.trim();
  }
  if (form.deployType === "image") body.imageName = form.imageName;

  // The server defaults both paths, so only a custom one is worth sending.
  if (form.composeFilePath && form.composeFilePath !== "docker-compose.yml") {
    body.composeFilePath = form.composeFilePath;
  }
  if (form.dockerfilePath && form.dockerfilePath !== "Dockerfile") {
    body.dockerfilePath = form.dockerfilePath;
  }

  // Direct sources carry their compose inline. Image deploys never do.
  if (form.source === "direct" && form.deployType !== "image" && form.composeContent.trim()) {
    body.composeContent = form.composeContent;
  }

  return body;
}

/** Starting `.env` content for a template, with values filled in where they can be inferred. */
export function templateEnvContent(template: Template): string {
  if (!template.defaultEnvVars?.length) return "";

  const slug = slugify(template.name);
  const lines: string[] = [`# ${template.displayName} configuration`];

  for (const ev of template.defaultEnvVars) {
    let value = ev.defaultValue || "";

    if (!value) {
      if (isSecretKey(ev.key) || ev.key.toLowerCase().includes("salt")) {
        value = generatePassword();
      } else {
        value = inferEnvValue(ev.key, slug);
      }
    }

    if (ev.description) lines.push(`# ${ev.description}`);
    lines.push(`${ev.key}=${value}`);
  }

  lines.push("", "# Add your own variables below");
  return lines.join("\n");
}

// Prefixed keys are matched by suffix so GITEA_DOMAIN resolves like DOMAIN.
// Bare `_url` and `_host` are left out: DATABASE_URL and WORDPRESS_DB_HOST point
// at compose services, not at the app.
const URL_KEYS = ["url", "base_url", "app_url", "site_url", "public_url", "nextauth_url"];
const URL_SUFFIXES = ["_base_url", "_app_url", "_site_url", "_public_url"];
const DOMAIN_KEYS = ["domain", "hostname", "host", "virtual_host", "server_name"];
const DOMAIN_SUFFIXES = ["_domain", "_hostname", "_virtual_host", "_server_name"];
const PORT_KEYS = ["port", "app_port", "server_port"];
const PORT_SUFFIXES = ["_app_port", "_server_port"];

function matchesKey(lower: string, exact: string[], suffixes: string[]): boolean {
  return exact.includes(lower) || suffixes.some((s) => lower.endsWith(s));
}

function inferEnvValue(key: string, slug: string): string {
  const lower = key.toLowerCase();
  if (matchesKey(lower, URL_KEYS, URL_SUFFIXES)) return "${project.url}";
  if (matchesKey(lower, DOMAIN_KEYS, DOMAIN_SUFFIXES)) return "${project.domain}";
  if (matchesKey(lower, PORT_KEYS, PORT_SUFFIXES)) return "${project.port}";
  if (lower === "node_env") return "production";
  if (lower.includes("_database") || lower.includes("_db")) return slug;
  if (lower.includes("_user") && !lower.includes("password")) return slug;
  return "";
}

/** Required template vars left blank in the current `.env` content. */
export function missingRequiredEnvKeys(
  template: Pick<Template, "defaultEnvVars"> | null,
  envContent: string
): string[] {
  if (!template?.defaultEnvVars?.length) return [];
  const values = new Map(parseEnvContent(envContent).map((v) => [v.key, v.value]));
  return template.defaultEnvVars
    .filter((ev) => ev.required && !(values.get(ev.key) ?? "").trim())
    .map((ev) => ev.key);
}
