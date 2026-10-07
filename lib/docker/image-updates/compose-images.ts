import { parseImageRef, type ImageRef } from "./image-ref";
import { parseComposeYaml } from "../compose-validate";

export interface ServiceImage {
  /** Compose service name. Null for single-image apps. */
  service: string | null;
  image: string;
  ref: ImageRef;
}

/** Every pinnable image in raw compose YAML. Services with `build:` are skipped. */
export function extractComposeImages(yamlContent: string): ServiceImage[] {
  let root: unknown;
  try {
    root = parseComposeYaml(yamlContent);
  } catch {
    return [];
  }
  const services = (root as { services?: unknown } | null)?.services;
  if (!services || typeof services !== "object") return [];

  const found: ServiceImage[] = [];
  for (const [service, raw] of Object.entries(services as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const svc = raw as { image?: unknown; build?: unknown };
    if (svc.build) continue;
    if (typeof svc.image !== "string") continue;

    const ref = parseImageRef(svc.image);
    if (!ref) continue;
    found.push({ service, image: svc.image, ref });
  }
  return found;
}

export interface UpdatableApp {
  deployType: string | null;
  imageName: string | null;
  composeContent: string | null;
  composeService: string | null;
}

/** Images an app is responsible for. A child service reports only its own. */
export function appImages(app: UpdatableApp): ServiceImage[] {
  if (app.deployType === "image") {
    const ref = app.imageName ? parseImageRef(app.imageName) : null;
    return ref ? [{ service: null, image: app.imageName as string, ref }] : [];
  }
  if (!app.composeContent) return [];

  const images = extractComposeImages(app.composeContent);
  if (!app.composeService) return images;
  return images.filter((entry) => entry.service === app.composeService);
}
