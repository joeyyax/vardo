export const DEFAULT_BASE_DOMAIN = process.env.HOST_BASE_DOMAIN || "joeyyax.dev";

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

export function getBaseDomain(orgBaseDomain?: string | null): string {
  return orgBaseDomain || DEFAULT_BASE_DOMAIN;
}

export function generateSubdomain(
  projectName: string,
  baseDomain?: string | null
): string {
  const base = getBaseDomain(baseDomain);
  const { adjective, noun } = generateWordPair();
  return `${projectName}-${adjective}-${noun}.${base}`;
}
