/** The parts of a tool's JSON input schema the CLI reads. */
export type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  default?: unknown;
};

export type Tool = { name: string; description?: string; inputSchema?: JsonSchema };

/** How a flag's text becomes a value; `json` covers objects and untyped properties. */
export type Kind = "string" | "number" | "integer" | "boolean" | "array" | "json";

export type Flag = {
  /** Kebab-case, without the leading dashes. */
  name: string;
  prop: string;
  kind: Kind;
  /** Element kind for arrays. */
  item?: Kind;
  choices?: (string | number)[];
  nullable: boolean;
  required: boolean;
  description?: string;
  default?: unknown;
};

/** `appId` → `app-id`, `pr_url` → `pr-url`. */
export function kebab(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/** `vardo_deploy_app` → `deploy-app`. */
export function commandName(toolName: string): string {
  return kebab(toolName.replace(/^vardo_/, ""));
}

type Shape = { kind: Kind; item?: Kind; choices?: (string | number)[]; nullable: boolean };

function kindOf(type: string): Kind {
  if (type === "object") return "json";
  if (type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "array") return type;
  return "json";
}

/** Flattens anyOf, oneOf, type lists, enums and consts into one kind. */
export function shapeOf(schema: JsonSchema): Shape {
  const variants = schema.anyOf ?? schema.oneOf ?? [schema];
  let kind: Kind | undefined;
  let item: Kind | undefined;
  let nullable = false;
  const choices: (string | number)[] = [];

  for (const v of variants) {
    const types = v.type === undefined ? [] : Array.isArray(v.type) ? v.type : [v.type];
    if (types.includes("null") || v.const === null) nullable = true;
    for (const c of [...(v.enum ?? []), ...(v.const !== undefined ? [v.const] : [])]) {
      if (typeof c === "string" || typeof c === "number") choices.push(c);
    }
    const t = types.find((x) => x !== "null");
    if (!kind && t) {
      kind = kindOf(t);
      if (kind === "array") item = v.items ? shapeOf(v.items).kind : "string";
    }
    if (!kind && v.const !== undefined && v.const !== null) {
      kind = typeof v.const === "number" ? "number" : typeof v.const === "boolean" ? "boolean" : "string";
    }
  }

  return { kind: kind ?? "json", item, nullable, ...(choices.length > 0 && { choices }) };
}

/** One flag per input property, required ones first. */
export function toolFlags(tool: Tool): Flag[] {
  const schema = tool.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  const flags = Object.entries(schema.properties ?? {}).map(([prop, s]): Flag => ({
    name: kebab(prop),
    prop,
    ...shapeOf(s),
    required: required.has(prop),
    description: s.description,
    default: s.default,
  }));
  return [...flags.filter((f) => f.required), ...flags.filter((f) => !f.required)];
}
