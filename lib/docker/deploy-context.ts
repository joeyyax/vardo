// Deploy pipeline state. Steps mutate their own fields and throw on failure; runDeployment handles recovery.

import type { ComposeFile, ServiceConfigOverride } from "./compose-types";
import type { HostConfig } from "@/lib/config/host-config";
import type { DeployStage } from "./deploy-logger";

export type DeployStatus = "running" | "success" | "failed" | "skipped";

/** Result of stopping the old slot. `ok: false` means its containers are still up. */
export type SlotStopOutcome = { ok: true } | { ok: false; message: string };

/** App row as loaded by runDeployment, with domains. */
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
  priority: "critical" | "standard" | "disposable" | null;
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
    /** Compose service this domain targets; null for the parent's own domains (primary service). */
    composeService?: string | null;
    pathPrefix?: string | null;
    stripPathPrefix?: boolean | null;
    middlewares?: string | null;
  }[];
};

export type DeployContext = {
  // Input
  deploymentId: string;
  appId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback";
  triggeredBy?: string;
  environmentId?: string;
  groupEnvironmentId?: string;
  signal?: AbortSignal;

  /** Set for a rollback; `app` is already overlaid with the target's snapshot. */
  rollback?: { targetDeploymentId: string; gitSha: string | null };

  // Resolved by earlier steps
  app: DeployApp;

  /** Organization record (subset). */
  org: { id: string; name: string; baseDomain: string | null; trusted: boolean } | null;
  orgTrusted: boolean;
  projectAllowBindMounts: boolean;
  projectAllowDockerSocket: boolean;

  /** Environment resolution. */
  envName: string;
  envType: "production" | "staging" | "preview" | "local";
  envBranchOverride: string | null;
  /** Not the app's default environment: no production hostnames, names or state. */
  envIsolated?: boolean;

  /** Merged env vars (app + host.toml + org). */
  envMap: Record<string, string>;

  /** Persistent volumes from the volumes table. */
  volumesList: { name: string; mountPath: string }[];
  /** Raw volume rows for dedup checking. */
  appVolumes: { id: string; name: string; mountPath: string; persistent: boolean | null }[];

  /** Effective source after auto-upgrade (direct -> git when compose has build:). */
  effectiveSource: string;

  /** Parsed compose file. */
  compose: ComposeFile;

  /** The bare compose before Vardo injections (for docker-compose.yml). */
  bareCompose: ComposeFile;

  /** Per-service overrides from decomposed child apps, keyed by service name. (#745) */
  serviceConfig: Record<string, ServiceConfigOverride>;

  /** Whether the image was built locally (Nixpacks/Railpack/Dockerfile). */
  builtLocally: boolean;

  /** Image refs built locally this deploy. The swap pre-pull must skip them or `compose pull` 404s. */
  builtImageRefs: string[];

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

  /** Stops the old slot; post-deploy calls it only after the deploy commits. */
  stopOldSlot?: () => Promise<SlotStopOutcome>;

  /** The old slot is running this process (Vardo deploying Vardo), so its stop ends the deploy. */
  stopOldSlotEndsDeploy?: boolean;

  /** Whether the old slot's rotating services are still running. */
  oldSlotServing?: () => Promise<boolean>;

  /** Unfinished work, written to the deployment row by post-deploy. */
  unfinished?: string[];

  /** Shared services whose bind data still sits in a slot dir; the swap holds them so they never recreate onto an empty dir. */
  sharedPathMoves?: Record<string, string[]>;

  /** Set once the deploy records success; the new slot is live from here. */
  succeeded?: boolean;

  // Logging and lifecycle
  log: (line: string) => string;
  stage: (stage: DeployStage, status: DeployStatus) => void;
  checkAbort: () => void;
  /** Proxy object for helpers that expect { push }. */
  logs: { push: (line: string) => void };
  logLines: string[];
  startTime: number;
};
