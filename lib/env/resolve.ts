// Resolves env expressions like ${VAR}, ${project.name} and ${postgres.DATABASE_URL} at deploy time.

const EXPRESSION_RE = /\$\{([^}]+)\}/g;

const BUILTIN_PROJECT_FIELDS = new Set([
  "name",
  "displayName",
  "port",
  "id",
  "domain",
  "url",
  "host",
  "internalHost",
  "gitUrl",
  "gitBranch",
  "imageName",
]);
const BUILTIN_ORG_FIELDS = new Set(["name", "id", "baseDomain"]);

export type ResolveContext = {
  project: {
    id: string;
    name: string;
    displayName: string;
    containerPort: number | null;
    domain?: string | null;
    gitUrl?: string | null;
    gitBranch?: string | null;
    imageName?: string | null;
  };
  org: {
    id: string;
    name: string;
    baseDomain?: string | null;
  };
  /** Current project's env vars (key -> raw value, pre-resolution) */
  envVars: Record<string, string>;
  /** Org-level shared env vars (key -> value) */
  orgEnvVars?: Record<string, string>;
  /** Callback to resolve a var from another project in the same org */
  resolveExternalVar: (
    projectName: string,
    varKey: string,
  ) => Promise<string | null>;
};

export class EnvResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvResolutionError";
  }
}

/** Returns the `${...}` expression bodies in a value, without the wrapper. */
export function extractExpressions(value: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(EXPRESSION_RE.source, EXPRESSION_RE.flags);
  while ((match = re.exec(value)) !== null) {
    results.push(match[1]);
  }
  return results;
}

/** Categorizes an expression for UI display. */
export function validateExpression(
  expression: string,
): { type: "self" | "cross-project" | "builtin" | "org-var"; target: string } {
  const dotIndex = expression.indexOf(".");
  if (dotIndex === -1) {
    return { type: "self", target: expression };
  }

  const prefix = expression.slice(0, dotIndex);
  const field = expression.slice(dotIndex + 1);

  if (prefix === "project" && BUILTIN_PROJECT_FIELDS.has(field)) {
    return { type: "builtin", target: expression };
  }
  if (prefix === "org" && BUILTIN_ORG_FIELDS.has(field)) {
    return { type: "builtin", target: expression };
  }
  if (prefix === "org") {
    return { type: "org-var", target: field };
  }

  // Any other dotted expression is a cross-project reference
  return { type: "cross-project", target: expression };
}

/** Resolves all `${...}` expressions in one value; `resolvedSelf` holds already-resolved self-references. */
export async function resolveEnvValue(
  value: string,
  context: ResolveContext,
  resolvedSelf?: Record<string, string>,
): Promise<string> {
  const expressions = extractExpressions(value);
  if (expressions.length === 0) return value;

  let result = value;

  for (const expr of expressions) {
    const resolved = await resolveOneExpression(expr, context, resolvedSelf);
    if (resolved === null) {
      throw new EnvResolutionError(
        `Failed to resolve expression \${${expr}}: no value found`,
      );
    }
    result = result.replace(`\${${expr}}`, resolved);
  }

  return result;
}

async function resolveOneExpression(
  expression: string,
  context: ResolveContext,
  resolvedSelf?: Record<string, string>,
): Promise<string | null> {
  const dotIndex = expression.indexOf(".");
  if (dotIndex === -1) {
    // Bare name -> self-reference to another env var in this project
    if (resolvedSelf && expression in resolvedSelf) {
      return resolvedSelf[expression];
    }
    if (expression in context.envVars) {
      return context.envVars[expression];
    }
    return null;
  }

  const prefix = expression.slice(0, dotIndex);
  const field = expression.slice(dotIndex + 1);

  // Built-in project fields
  if (prefix === "project") {
    switch (field) {
      case "name":
        return context.project.name;
      case "displayName":
        return context.project.displayName;
      case "port":
        return context.project.containerPort?.toString() ?? null;
      case "id":
        return context.project.id;
      case "domain":
        return context.project.domain ?? null;
      case "url":
        return context.project.domain
          ? `https://${context.project.domain}`
          : null;
      case "host":
        return context.project.domain ?? null;
      case "internalHost":
        // Service name on the shared network.
        return context.project.name;
      case "gitUrl":
        return context.project.gitUrl ?? null;
      case "gitBranch":
        return context.project.gitBranch ?? null;
      case "imageName":
        return context.project.imageName ?? null;
      default:
        return null;
    }
  }

  // Org fields — built-ins first, then org-level env vars
  if (prefix === "org") {
    switch (field) {
      case "name":
        return context.org.name;
      case "id":
        return context.org.id;
      case "baseDomain":
        return context.org.baseDomain ?? null;
      default:
        if (context.orgEnvVars && field in context.orgEnvVars) {
          return context.orgEnvVars[field];
        }
        return null;
    }
  }

  // Cross-project reference
  return context.resolveExternalVar(prefix, field);
}

/** Resolves a project's env vars in dependency order. Throws on circular self-references. */
export async function resolveAllEnvVars(
  vars: Record<string, string>,
  context: ResolveContext,
): Promise<Record<string, string>> {
  // Build a dependency graph of self-references only
  const selfDeps = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(vars)) {
    const deps = new Set<string>();
    for (const expr of extractExpressions(value)) {
      const { type, target } = validateExpression(expr);
      if (type === "self" && target in vars) {
        deps.add(target);
      }
    }
    selfDeps.set(key, deps);
  }

  const order = topologicalSort(selfDeps);

  const resolved: Record<string, string> = {};

  const ctxWithVars: ResolveContext = { ...context, envVars: vars };

  for (const key of order) {
    resolved[key] = await resolveEnvValue(
      vars[key],
      ctxWithVars,
      resolved,
    );
  }

  return resolved;
}

/** Kahn's algorithm. Throws on cycles. */
function topologicalSort(graph: Map<string, Set<string>>): string[] {
  const inDegree = new Map<string, number>();
  for (const key of graph.keys()) {
    if (!inDegree.has(key)) inDegree.set(key, 0);
    for (const dep of graph.get(key)!) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 0); // ensure dep exists
    }
  }

  // inDegree[key] = number of deps key has
  for (const [key, deps] of graph) {
    inDegree.set(key, deps.size);
  }

  const queue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const [key, deps] of graph) {
      if (deps.has(current)) {
        const newDegree = inDegree.get(key)! - 1;
        inDegree.set(key, newDegree);
        if (newDegree === 0) queue.push(key);
      }
    }
  }

  if (result.length !== graph.size) {
    const unresolved = [...graph.keys()].filter((k) => !result.includes(k));
    throw new EnvResolutionError(
      `Circular env var reference detected among: ${unresolved.join(", ")}`,
    );
  }

  return result;
}
