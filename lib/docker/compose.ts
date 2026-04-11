// ---------------------------------------------------------------------------
// Barrel re-export for Docker Compose modules.
//
// All public exports from the decomposed modules are re-exported here so
// existing import paths (`from "./compose"` / `from "@/lib/docker/compose"`)
// continue to work without changes.
// ---------------------------------------------------------------------------

// Types
export type {
  ResourceLimits,
  HealthCheck,
  Ulimits,
  ComposeDependsOnCondition,
  ComposeDependsOn,
  ComposeService,
  ComposeFile,
  PortMapping,
  ContainerConfig,
  DeployTransformDomain,
  ComposePreviewApp,
  ValidateOptions,
} from "./compose-types";
export { dependsOnKeys } from "./compose-types";

// Parsing & serialization
export { composeToYaml, parseCompose } from "./compose-parse";

// Validation & sanitization
export {
  ALLOWED_NETWORK_MODES,
  ALLOWED_RUNTIMES,
  isAnonymousVolume,
  validateCompose,
  sanitizeCompose,
} from "./compose-validate";

// Generation
export {
  TRAEFIK_LABEL_PREFIX,
  nanosToDuration,
  generateComposeForImage,
  narrowBackendProtocol,
  resolveBackendProtocol,
  generateComposeFromContainer,
} from "./compose-generate";

// Injection, stripping, overlays, ports, deploy transforms
export {
  injectTraefikLabels,
  stripTraefikLabels,
  slotComposeFiles,
  stripVardoInjections,
  excludeServices,
  buildVardoOverlay,
  injectNetwork,
  getTraefikRoutedServices,
  injectResourceLimits,
  injectGpuDevices,
  getServicesWithExternalizedVolumes,
  detectPorts,
  parsePortString,
  stripHostPorts,
  applyDeployTransforms,
  buildComposePreview,
} from "./compose-inject";

// Normalization
export type { NormalizeChange, NormalizeResult, NormalizeOptions } from "./compose-normalize";
export { normalizeCompose, getRoutedServices } from "./compose-normalize";

// Analysis
export type {
  FindingSeverity,
  FindingCategory,
  Finding,
  ComposeAnalysis,
} from "./compose-analyze";
export { analyzeCompose, analyzeRawCompose } from "./compose-analyze";

// Compose service sync (child app records)
export { syncComposeServices } from "./compose-sync";
