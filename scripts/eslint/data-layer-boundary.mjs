import path from "node:path";

// Pages, layouts and client components reach data through lib/app-services, never the db or Docker modules.

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Modules no page, layout or client component may import a value from. */
const RESTRICTED = [/^@\/lib\/db$/, /^@\/lib\/db\//, /^@\/lib\/docker\//];

/** Also off limits to client components: the services run server-side. */
const SERVER_ONLY = [/^@\/lib\/app-services(\/|$)/];

/** Pure helpers under lib/docker with no Docker or db dependency, shared with client components. */
const CLIENT_SAFE = new Set([
  "@/lib/docker/conditions",
  "@/lib/docker/deploy-vars",
  "@/lib/docker/image-updates/batch-report",
  "@/lib/docker/image-updates/ignore",
  "@/lib/docker/image-updates/migration-path",
  "@/lib/docker/image-updates/pending",
]);

const ROUTE_ENTRY = /(^|\/)app\/(.+\/)?(page|layout)\.[jt]sx?$/;

function isClient(program) {
  return program.body.some((s) => s.type === "ExpressionStatement" && s.directive === "use client");
}

/** The import as an `@/` path, resolving relative specifiers against the file. */
function normalize(source, filename) {
  if (!source.startsWith(".")) return source;
  const abs = path.resolve(path.dirname(filename), source);
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  return rel.startsWith("..") ? source : `@/${rel.replace(/\.[jt]sx?$/, "").replace(/\/index$/, "")}`;
}

function typeOnly(node) {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  const specifiers = node.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every((s) => s.importKind === "type" || s.exportKind === "type");
}

/** @type {import("eslint").Rule.RuleModule} */
export const dataLayerBoundary = {
  meta: {
    type: "problem",
    docs: { description: "Keep the db and Docker layers out of pages, layouts and client components." },
    schema: [],
    messages: {
      restricted:
        "{{kind}} can't import {{source}}. Read through a function in @/lib/app-services instead.",
      serverOnly: "Client components can't import {{source}}; pass the data down from a server component.",
    },
  },
  create(context) {
    const filename = path.relative(ROOT, context.filename).split(path.sep).join("/");
    const entry = ROUTE_ENTRY.test(filename);
    let client = false;

    const check = (node) => {
      if (!node.source || typeof node.source.value !== "string") return;
      if (!entry && !client) return;
      if (typeOnly(node)) return;
      const source = normalize(node.source.value, context.filename);
      if (client && SERVER_ONLY.some((re) => re.test(source))) {
        context.report({ node: node.source, messageId: "serverOnly", data: { source } });
        return;
      }
      if (CLIENT_SAFE.has(source)) return;
      if (RESTRICTED.some((re) => re.test(source))) {
        const kind = client ? "A client component" : `A ${filename.match(ROUTE_ENTRY)?.[3] ?? "page"}`;
        context.report({ node: node.source, messageId: "restricted", data: { kind, source } });
      }
    };

    return {
      Program(program) {
        client = isClient(program);
      },
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression(node) {
        if (node.source.type === "Literal") check({ source: node.source });
      },
    };
  },
};

const plugin = { rules: { "data-layer-boundary": dataLayerBoundary } };

export default plugin;
