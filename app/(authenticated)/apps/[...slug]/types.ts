import type { FeatureFlags } from "@/lib/config/features";

export type Deployment = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "rolled_back" | "superseded";
  supersededBy: string | null;
  trigger: "manual" | "webhook" | "api" | "rollback";
  gitSha: string | null;
  gitMessage: string | null;
  durationMs: number | null;
  log: string | null;
  environmentId: string | null;
  configSnapshot: Record<string, unknown> | null;
  rollbackFromId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  triggeredByUser: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
};

export type Domain = {
  id: string;
  domain: string;
  serviceName: string | null;
  port: number | null;
  certResolver: string | null;
  isPrimary: boolean | null;
  redirectTo: string | null;
  redirectCode: number | null;
};

export type EnvVar = {
  id: string;
  key: string;
  value: string;
  isSecret: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Environment = {
  id: string;
  name: string;
  type: "production" | "staging" | "preview";
  domain: string | null;
  gitBranch: string | null;
  isDefault: boolean | null;
  createdAt: Date;
};

export type Tag = {
  id: string;
  name: string;
  color: string;
};

export type RollbackPreview = {
  deploymentId: string;
  gitSha: string | null;
  gitMessage: string | null;
  deployedAt: string;
  hasEnvSnapshot: boolean;
  hasConfigSnapshot: boolean;
  configChanges: { field: string; from: string | null; to: string | null }[];
  envKeyChanges: { added: string[]; removed: string[]; changed: string[] } | null;
};

export type ChildApp = {
  id: string;
  name: string;
  displayName: string;
  composeService: string | null;
  status: string;
  imageName: string | null;
  domains: { domain: string; isPrimary: boolean | null }[];
};

export type App = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: "git" | "direct";
  deployType: "compose" | "dockerfile" | "image" | "static" | "nixpacks" | "railpack";
  gitUrl: string | null;
  gitBranch: string | null;
  imageName: string | null;
  composeFilePath: string | null;
  composeContent: string | null;
  composeService: string | null;
  parentAppId: string | null;
  dockerfilePath: string | null;
  rootDirectory: string | null;
  containerPort: number | null;
  autoTraefikLabels: boolean | null;
  autoDeploy: boolean | null;
  restartPolicy: string | null;
  connectionInfo: { label: string; value: string; copyRef?: string }[] | null;
  exposedPorts: { internal: number; external?: number; description?: string }[] | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean | null;
  backendProtocol: "http" | "https" | null;
  diskWriteAlertThreshold: number | null;
  healthCheckTimeout: number | null;
  autoRollback: boolean | null;
  rollbackGracePeriod: number | null;
  projectId: string | null;
  cloneStrategy: string | null;
  dependsOn: string[] | null;
  status: "active" | "stopped" | "error" | "deploying";
  needsRedeploy: boolean | null;
  importedContainerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deployments: Deployment[];
  domains: Domain[];
  envVars: EnvVar[];
  environments: Environment[];
  appTags?: { tag: Tag }[];
  project?: { id: string; name: string; displayName: string; color: string | null } | null;
  childApps?: ChildApp[];
};

export type AppDetailProps = {
  app: App;
  orgId: string;
  userRole: string;
  allTags?: Tag[];
  allParentApps?: { id: string; name: string; color: string }[];
  allAppNames?: string[];
  orgVarKeys?: string[];
  siblings?: { id: string; name: string; displayName: string; status: string; dependsOn: string[] | null }[];
  initialTab?: string;
  initialEnv?: string;
  initialSubView?: string;
  featureFlags: FeatureFlags;
  parentApp?: { id: string; name: string; displayName: string } | null;
};
