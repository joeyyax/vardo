// Server only, except generateWordPair. Client components get baseDomain as a prop from getInstanceConfig().

export const DEFAULT_BASE_DOMAIN = process.env.VARDO_BASE_DOMAIN || "localhost";

const ADJECTIVES = [
  "spicy",
  "fizzy",
  "golden",
  "crispy",
  "smoky",
  "zesty",
  "frosty",
  "tangy",
  "silky",
  "bubbly",
  "toasty",
  "minty",
  "hazy",
  "malty",
  "hoppy",
  "bitter",
  "bold",
  "bright",
  "cosmic",
  "electric",
  "lunar",
  "solar",
  "stellar",
  "atomic",
  "turbo",
  "mega",
  "hyper",
  "swift",
  "lazy",
  "chill",
  "wild",
  "lucky",
  "snappy",
  "peppy",
  "punchy",
  "stormy",
  "misty",
  "dusty",
  "rusty",
  "sunny",
] as const;

const NOUNS = [
  "mango",
  "lemon",
  "peach",
  "melon",
  "ginger",
  "cedar",
  "maple",
  "basil",
  "cocoa",
  "mocha",
  "chai",
  "matcha",
  "cider",
  "porter",
  "stout",
  "lager",
  "pilsner",
  "mule",
  "julep",
  "toddy",
  "sling",
  "punch",
  "tonic",
  "bitters",
  "sage",
  "thyme",
  "clove",
  "nutmeg",
  "fennel",
  "ember",
  "flint",
  "quartz",
  "cobalt",
  "amber",
  "coral",
  "jade",
  "onyx",
  "opal",
  "ivory",
  "birch",
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateWordPair(): { adjective: string; noun: string } {
  return { adjective: pick(ADJECTIVES), noun: pick(NOUNS) };
}

/** The org's base domain, then the instance base domain, then `VARDO_BASE_DOMAIN`. */
export function pickBaseDomain(
  orgBaseDomain: string | null | undefined,
  instanceBaseDomain: string | null | undefined,
  envBaseDomain: string | null | undefined = process.env.VARDO_BASE_DOMAIN,
): string {
  return orgBaseDomain || instanceBaseDomain || envBaseDomain || "localhost";
}

/** The instance base domain from the admin settings, then `VARDO_BASE_DOMAIN`. */
export async function getInstanceBaseDomain(): Promise<string> {
  const { getInstanceConfig } = await import("@/lib/system-settings");
  return pickBaseDomain(null, (await getInstanceConfig()).baseDomain);
}

export async function getBaseDomain(orgBaseDomain?: string | null): Promise<string> {
  if (orgBaseDomain) return orgBaseDomain;
  return getInstanceBaseDomain();
}

/** Why the instance base domain and `VARDO_BASE_DOMAIN` can't both be right, or null. */
export function baseDomainMismatch(
  instanceBaseDomain: string | null | undefined,
  envBaseDomain: string | null | undefined = process.env.VARDO_BASE_DOMAIN,
): string | null {
  const inst = instanceBaseDomain?.trim().toLowerCase();
  const env = envBaseDomain?.trim().toLowerCase();
  if (!inst || !env || inst === env) return null;
  return `The instance base domain is ${inst} but VARDO_BASE_DOMAIN is ${env}. Orgs without their own base domain get auto-domains under ${inst}.`;
}

export function generateSubdomain(projectName: string, baseDomain: string): string {
  const { adjective, noun } = generateWordPair();
  return `${projectName}-${adjective}-${noun}.${baseDomain}`;
}

export function generateEnvironmentSubdomain(
  projectName: string,
  environmentName: string,
  baseDomain: string,
): string {
  const sanitized = environmentName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${projectName}-${sanitized}.${baseDomain}`;
}

export function generatePreviewSubdomain(
  projectName: string,
  prNumber: number,
  baseDomain: string,
): string {
  return `${projectName}-pr-${prNumber}.${baseDomain}`;
}
