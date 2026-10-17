import type { ResourceProfile } from "@/lib/db/schema/enums";
import type { SecurityHeaderConfig } from "@/lib/security/response-headers";
// Deploy pipeline state. Steps mutate their own fields and throw on failure; runDeployment handles recovery.

import type { ComposeFile, ServiceConfigOverride } from "./compose-types";
import type { HostConfig } from "@/lib/config/host-config";
import type { DeployStage, WaitWriter } from "./deploy-logger";
import type { RollbackTarget } from "./rollback-target";

import type { StageTimer } from "./stage-timings";
import type { BuildPlacementRecorder } from "./build-placement";
import type { BuildCacheMode, RebuildMode } from "./build-key";
import type { DeployStrategy } from "./deploy-strategy";
import type { DeploySlot } from "./build-gate";

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
  gitCredentials?: string | null;
  gitBranch: string | null;
  gitKeyId: string | null;
  imageName: string | null;
  composeContent: string | null;
  composeFilePath: string | null;
  dockerfilePath: string | null;
  rootDirectory: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  buildProvider?: "railpack" | "nixpacks" | null;
  buildCache?: BuildCacheMode | null;
  deployStrategy?: DeployStrategy | null;
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
  memoryProfile?: ResourceProfile | null;
  memoryReservation?: number | null;
  priority: "critical" | "standard" | "disposable" | null;
  gpuEnabled: boolean | null;
  certServices?: string[] | null;
  healthCheckTimeout: number | null;
  autoRollback: boolean | null;
  rollbackGracePeriod: number | null;
  backendProtocol: "http" | "https" | null;
  securityHeaders?: SecurityHeaderConfig;
  securityHeadersLive?: boolean;
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
    /** `domain.service_name`; a child app's domains carry its compose service. */
    serviceName?: string | null;
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
  trigger: "manual" | "webhook" | "api" | "rollback" | "relay" | "poll";
  triggeredBy?: string;
  environmentId?: string;
  groupEnvironmentId?: string;
  signal?: AbortSignal;
  /** Executor holding the row's claim. */
  claimedBy?: string;
  /** The deploy slot its claim took. On a build target's, it builds only there until it takes this server's. */
  deploySlot?: DeploySlot;
  /** Checked before the swap touches containers, and records the swap stage. False stops the deploy. */
  fence?: () => Promise<boolean>;

  /** Set for a rollback; `app` is already overlaid with the target's snapshot. */
  rollback?: { targetDeploymentId: string; gitSha: string | null };
  /** The rollback's target, applied to the app row once the deploy commits. */
  rollbackTarget?: RollbackTarget;

  /** A commit on the branch to deploy instead of its tip. */
  pinnedGitSha?: string;
  /** Why it's pinned: the commit a push named, or one someone chose. */
  pinIntent?: "push" | "pin";

  // Resolved by earlier steps
  app: DeployApp;

  /** Organization record (subset). */
  org: { id: string; name: string; baseDomain: string | null; trusted: boolean; memoryProfile?: ResourceProfile; isSystemManaged?: boolean } | null;
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

  /** Services left out of `compose` by an inactive profile. */
  profileSkipped?: string[];

  /** The bare compose before Vardo injections (for docker-compose.yml). */
  bareCompose: ComposeFile;

  /** The new slot's Vardo overlay (docker-compose.override.yml), once written. */
  overlayCompose?: ComposeFile;

  /** The compose before Vardo removed the app's own Traefik labels. */
  declaredCompose?: ComposeFile;

  /** The routers reference the app's headers file, so later header changes apply live. */
  headersLive?: boolean;

  /** Per-service overrides from decomposed child apps, keyed by service name. (#745) */
  serviceConfig: Record<string, ServiceConfigOverride>;

  /** The app's learned memory default and why, when it has one. */
  learnedMemory?: { mb: number; reason: string } | null;

  /** The project network every service joins. Null or unset keeps the app off it. */
  projectNetwork?: string | null;

  /** Whether the image was built locally (Nixpacks/Railpack/Dockerfile). */
  builtLocally: boolean;

  /** Image refs built locally this deploy. The swap pre-pull must skip them or `compose pull` 404s. */
  builtImageRefs: string[];

  /** host.toml config from repo root. */
  hostConfig: HostConfig | null;

  /** Cloned repo directory (app-level, shared across environments). */
  repoDir: string | null;

  /** This environment's copy of the deployed commit without .git; builds read it. Unset falls back to repoDir. */
  buildSourceDir?: string;
  /** The build tree carries .git because a Dockerfile reads it. */
  buildSourceHasGit?: boolean;

  /** Rebuild even when an image with this build key exists; "no-cache" also skips the layer cache. */
  rebuild?: RebuildMode;

  /** Identity of this deploy's repo build, stored on the deployment. */
  buildKey?: string;

  /** Commit this deploy ships. Unset for an app without a repo. */
  gitSha?: string;
  gitMessage?: string;
  gitAuthor?: string;

  /** Project name, for notifications. */
  projectName?: string;

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

  /** Compose -f and --env-file arguments for docker compose commands. */
  composeFileArgs: string[];

  /** Stable volume prefix for externalization. */
  stableVolumePrefix: string;

  /** Stops the old slot; post-deploy calls it only after the deploy commits. */
  stopOldSlot?: () => Promise<SlotStopOutcome>;

  /** The old slot is running this process (Vardo deploying Vardo), so its stop ends the deploy. */
  stopOldSlotEndsDeploy?: boolean;

  /** Whether the old slot's rotating services are still running. */
  oldSlotServing?: () => Promise<boolean>;

  /** Removes the Traefik hold on the old slot; cleared once the cutover pin replaces it. */
  releaseHold?: () => Promise<void>;

  /** Unfinished work, written to the deployment row by post-deploy. */
  unfinished?: string[];

  /** Shared services whose bind data still sits in a slot dir; the swap holds them so they never recreate onto an empty dir. */
  sharedPathMoves?: Record<string, string[]>;

  /** Set once the deploy records success; the new slot is live from here. */
  succeeded?: boolean;

  /** When the old slot was stopped ahead of the new one starting. Epoch ms. */
  oldStoppedAt?: number;

  /** When the new slot passed its health check. Epoch ms. */
  healthyAt?: number;

  // Logging and lifecycle
  log: (line: string) => string;
  /** Registers the secret-looking values of an env to redact from this deploy's log lines. */
  addSecrets?: (env: Record<string, string>) => void;
  stage: (stage: DeployStage, status: DeployStatus) => void;
  /** Opens or ends (null) a wait on this deploy's stream and row. */
  wait?: WaitWriter;
  checkAbort: () => void;
  /** Phase timings, persisted to `deployment.stage_timings`. */
  timer: StageTimer;
  /** Where the build ran, persisted to the deployment's build placement columns. */
  placement?: BuildPlacementRecorder;
  /** Proxy object for helpers that expect { push }. */
  logs: { push: (line: string) => void };
  logLines: string[];
  /** The row's log from before this run, such as requeue notes. Kept ahead of `logLines` when saved. */
  logPrefix?: string;
  startTime: number;
};

/** The deployment log to save: anything written before this run, then this run's lines. */
export function savedLog({ logLines, logPrefix }: Pick<DeployContext, "logLines" | "logPrefix">): string {
  const lines = logLines.join("\n");
  return logPrefix ? `${logPrefix}\n${lines}` : lines;
}
