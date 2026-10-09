import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

// Every exported handler under app/api must reach an auth or verify helper, or be allowlisted below.
// This catches drift, not wrong checks: it proves a guard runs, not that it guards the right thing.

const API_DIR = join(process.cwd(), "app/api");

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const GUARDS = new Set([
  "verifyOrgAccess",
  "verifyAppAccess",
  "verifyProjectAccess",
  "verifyAccess",
  "requireAdmin",
  "requireAdminAuth",
  "requireAppAdmin",
  "isAppAdmin",
  "requireSession",
  "getSession",
  "requireMeshPeer",
  "authenticateRequest",
  "setupTokenRefusal",
]);

/** Handlers that answer without a guard helper, keyed "path METHOD", each with its reason. */
const ALLOWLIST: Record<string, string> = {
  "health/route.ts GET": "liveness probe; returns no instance data",
  "auth/[...all]/route.ts GET": "Better Auth handler; authenticates the caller itself",
  "auth/[...all]/route.ts POST": "Better Auth handler; authenticates the caller itself",
  "mcp/route.ts GET": "static 405; stateless transport has no SSE stream",
  "mcp/route.ts DELETE": "static 204; stateless transport has no session to end",
  "setup/status/route.ts GET": "one boolean the root redirect already shows",
  "setup/token/route.ts POST": "trades the setup token for its cookie; closed once setup latches",
  "v1/email/pouch/webhook/route.ts POST": "HMAC signature checked against the Pouch webhook secret",
  "v1/github/webhook/route.ts POST": "HMAC signature checked against the webhook secret",
  "v1/mesh/join/route.ts POST": "redeems a single-use mesh invite code",
};

type Fn = ts.FunctionLikeDeclaration;

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

function isFn(node: ts.Node): node is Fn {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Top-level function and const bindings, plus the expression each exported method resolves to. */
function parse(source: string) {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const locals = new Map<string, ts.Node>();
  const exported = new Map<string, ts.Node>();

  for (const stmt of file.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      locals.set(stmt.name.text, stmt);
      if (isExported(stmt)) exported.set(stmt.name.text, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (ts.isIdentifier(decl.name)) {
          locals.set(decl.name.text, decl.initializer);
          if (isExported(stmt)) exported.set(decl.name.text, decl.initializer);
        } else if (ts.isObjectBindingPattern(decl.name) && isExported(stmt)) {
          for (const el of decl.name.elements) {
            if (ts.isIdentifier(el.name)) exported.set(el.name.text, decl.initializer);
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        const local = locals.get((spec.propertyName ?? spec.name).text);
        if (local) exported.set(spec.name.text, local);
      }
    }
  }
  return { locals, exported };
}

/** Whether evaluating the node reaches a guard call, following local bindings it references. */
function reachesGuard(node: ts.Node, locals: Map<string, ts.Node>, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);

  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && GUARDS.has(name)) {
        found = true;
        return;
      }
    }
    if (ts.isIdentifier(n)) {
      const local = locals.get(n.text);
      if (local && (isFn(local) || ts.isCallExpression(local)) && reachesGuard(local, locals, seen)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const handlers = routeFiles(API_DIR).flatMap((full) => {
  const rel = relative(API_DIR, full);
  const { locals, exported } = parse(readFileSync(full, "utf8"));
  return METHODS.filter((m) => exported.has(m)).map((m) => ({
    key: `${rel} ${m}`,
    guarded: reachesGuard(exported.get(m)!, locals),
  }));
});

describe("API route handlers", () => {
  it("finds handlers to check, so a bad path can't pass vacuously", () => {
    expect(handlers.length).toBeGreaterThan(250);
    expect(handlers.map((h) => h.key)).toContain("v1/organizations/[orgId]/apps/route.ts GET");
  });

  it.each(handlers.filter((h) => !(h.key in ALLOWLIST)).map((h) => [h.key, h.guarded]))(
    "%s reaches an auth or verify helper",
    (key, guarded) => {
      expect(guarded, `${key} calls none of: ${[...GUARDS].join(", ")}`).toBe(true);
    },
  );

  it("keeps each allowlist entry real and still unguarded", () => {
    const byKey = new Map(handlers.map((h) => [h.key, h.guarded]));
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(reason, key).toBeTruthy();
      expect(byKey.has(key), `${key} is allowlisted but no longer exists`).toBe(true);
      expect(byKey.get(key), `${key} is allowlisted but now calls a guard`).toBe(false);
    }
  });
});
