import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Every handler under app/api/v1/admin checks for an instance admin before it answers.

const ROOT = path.resolve(__dirname, "../../../../app/api/v1/admin");
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const GATES = new Set(["requireAppAdmin", "requireAdminAuth", "isAppAdmin"]);

/** "<route>:<METHOD>" handlers that answer without an admin session, with the reason. */
const EXEMPT: Record<string, string> = {};

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === "route.ts" ? [full] : [];
  });
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function isFn(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function parse(file: string) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const fns = new Map<string, Fn>();
  const handlers = new Map<string, ts.Node | undefined>();
  const exported = (s: ts.Statement) =>
    ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) {
      fns.set(s.name.text, s);
      if (exported(s) && METHODS.has(s.name.text)) handlers.set(s.name.text, s);
    }
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      if (isFn(d.initializer)) fns.set(d.name.text, d.initializer);
      if (!exported(s) || !METHODS.has(d.name.text)) continue;
      // export const GET = withRateLimit(handler, ...) names the handler as its first argument.
      const init = ts.isCallExpression(d.initializer) ? d.initializer.arguments[0] : d.initializer;
      handlers.set(d.name.text, ts.isIdentifier(init) ? undefined : init);
      if (ts.isIdentifier(init)) handlers.set(d.name.text, fns.get(init.text));
    }
  }
  return { fns, handlers };
}

/** Whether `node` calls a gate, following calls to functions in the same file. */
function callsGate(node: ts.Node, fns: Map<string, Fn>, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.text;
      const local = fns.get(callee);
      if (GATES.has(callee) || (local && callsGate(local, fns, seen))) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const files = routeFiles(ROOT);

describe("admin API routes", () => {
  it("finds routes to check, so a bad path cannot pass vacuously", () => {
    const rels = files.map((f) => path.relative(ROOT, f));
    expect(files.length).toBeGreaterThan(30);
    expect(rels).toContain("maintenance/detached-volumes/route.ts");
    expect(rels).toContain("maintenance/detached-volumes/[name]/route.ts");
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))("%s checks for an instance admin in every handler", (rel, file) => {
    const { fns, handlers } = parse(file);
    expect(handlers.size, `${rel} exports no handler`).toBeGreaterThan(0);
    for (const [method, node] of handlers) {
      if (`${rel}:${method}` in EXEMPT) continue;
      expect(node && callsGate(node, fns), `${rel} ${method} never checks for an instance admin`).toBe(true);
    }
  });
});
