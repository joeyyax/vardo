// ---------------------------------------------------------------------------
// DeployContext — typed carrier object for deploy pipeline state
//
// Replaces the ~12 hoisted variables in runDeployment(). Each step receives
// the context, reads what it needs, mutates its own fields, and returns it.
// The orchestrator (runDeployment) owns the context and handles all error
// recovery — steps just throw on failure.
// ---------------------------------------------------------------------------

import type { ComposeFile } from "./compose-types";
import type { HostConfig } from "@/lib/config/host-config";
import type { DeployStage } from "./deploy-logger";

export type DeployStatus = "running" | "success" | "failed" | "skipped";

/**
 * The app record shape as returned by the db query in runDeployment.
 * Uses `with: { domains: true }` so domains is always present.
 */
export type DeployApp = {
  id: string;
  organizationId: string;
  name: string;
  displayName: string;
  description: string | null;
  source: "git" | "direct" | "image";
  deployType: "compose" | "dockerfile" | "nixpacks" | "railpack" | "image";
  gitUrl: string | null;
  gitBranch: string | null;
  gitKeyId: string | null;
  imageName: string | null;
  composeContent: string | null;
  composeFilePath: string | null;
  dockerfilePath: string | null;
  rootDirectory: string | null;
  autoTraefikLabels: boolean | null;
  containerPort: number | null;
  autoDeploy: boolean | null;
  exposedPorts: { internal: number; external?: number; protocol?: string }[] | null;
  restartPolicy: string | null;
  projectId: string;
  templateName: string | null;
  status: string;
  needsRedeploy: boolean | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean | null;
  healthCheckTimeout: number | null;
  autoRollback: boolean | null;
  rollbackGracePeriod: number | null;
  backendProtocol: "http" | "https" | null;
  envContent: string | null;
  parentAppId: string | null;
  composeService: string | null;
  containerName: string | null;
  importedContainerId: string | null;
  importedComposeProject: string | null;
  configSource: string | null;
  domains: {
    id: string;
    domain: string;
    isPrimary: boolean | null;
    port: number | null;
    sslEnabled: boolean | null;
    certResolver: string | null;
    redirectTo: string | null;
    redirectCode: number | null;
  }[];
};

export type DeployContext = {
  // -----------------------------------------------------------------------
  // Input (from DeployOpts + createDeployment)
  // -----------------------------------------------------------------------
  deploymentId: string;
  appId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback";
  triggeredBy?: string;
  environmentId?: string;
  groupEnvironmentId?: string;
  signal?: AbortSignal;

  // -----------------------------------------------------------------------
  // Resolved during execution — set by early steps, read by later ones
  // -----------------------------------------------------------------------
  app: DeployApp;

  /** Organization record (subset). */
  org: { id: string; name: string; baseDomain: string | null; trusted: boolean } | null;
  orgTrusted: boolean;
  projectAllowBindMounts: boolean;

  /** Environment resolution. */
  envName: string;
  envType: "production" | "staging" | "preview" | "local";
  envBranchOverride: string | null;

  /** Merged env vars (app + host.toml + org). */
  envMap: Record<string, string>;

  /** Persistent volumes from the volumes table. */
  volumesList: { name: string; mountPath: string }[];
  /** Raw volume rows for dedup checking. */
  appVolumes: { id: string; name: string; mountPath: string; persistent: boolean | null }[];

  /** Effective source after auto-upgrade (direct -> git when compose has build:). */
  effectiveSource: string;

  /** Parsed compose file — set by prepare-repo or direct compose path. */
  compose: ComposeFile;

  /** The bare compose before Vardo injections (for docker-compose.yml). */
  bareCompose: ComposeFile;

  /** Whether the image was built locally (Nixpacks/Railpack/Dockerfile). */
  builtLocally: boolean;

  /** host.toml config from repo root. */
  hostConfig: HostConfig | null;

  /** Cloned repo directory (app-level, shared across environments). */
  repoDir: string | null;

  /** App base directory. */
  appBase: string;

  /** Environment-level directory. */
  appDir: string;

  /** Blue/green (or local) slot directory. */
  slotDir: string;

  /** Compose project name for the new slot. */
  newProjectName: string;

  /** Currently active slot before this deploy ("blue" | "green" | null). */
  activeSlot: "blue" | "green" | null;

  /** The new slot being deployed to ("blue" | "green" | "local"). */
  newSlot: string;

  /** Whether this is a local environment (no blue-green). */
  isLocalEnv: boolean;

  /** Detected or configured container port. */
  containerPort: number;

  /** Compose -f arguments for docker compose commands. */
  composeFileArgs: string[];

  /** Stable volume prefix for externalization. */
  stableVolumePrefix: string;

  // -----------------------------------------------------------------------
  // Logging & lifecycle
  // -----------------------------------------------------------------------
  log: (line: string) => string;
  stage: (stage: DeployStage, status: DeployStatus) => void;
  checkAbort: () => void;
  /** Proxy object for helpers that expect { push }. */
  logs: { push: (line: string) => void };
  logLines: string[];
  startTime: number;
};
