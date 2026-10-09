import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CAPABILITIES, can, type Capability } from "@/lib/auth/permissions";

// Every handler under app/api/v1/organizations names the capability it needs (#788).

const ROOT = path.resolve(__dirname, "../../../../../app/api/v1/organizations");
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const GATES = new Set(["verifyOrgAccess", "verifyAppAccess"]);

// Not org-scoped: list/create orgs and switch the current one.
const EXEMPT = new Set(["route.ts", "switch/route.ts"]);

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === "route.ts" ? [full] : [];
  });
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function localFunctions(sf: ts.SourceFile): Map<string, Fn> {
  const fns = new Map<string, Fn>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) fns.set(stmt.name.text, stmt);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          fns.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return fns;
}

/** Exported method name → the local function that handles it. */
function handlers(sf: ts.SourceFile, fns: Map<string, Fn>): Map<string, Fn | undefined> {
  const out = new Map<string, Fn | undefined>();
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name && METHODS.has(stmt.name.text)) {
      out.set(stmt.name.text, stmt);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !METHODS.has(d.name.text) || !d.initializer) continue;
        let init: ts.Expression = d.initializer;
        while (ts.isCallExpression(init)) init = init.arguments[0];
        if (ts.isIdentifier(init)) out.set(d.name.text, fns.get(init.text));
        else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.set(d.name.text, init);
        else out.set(d.name.text, undefined);
      }
    }
  }
  return out;
}

/** Capabilities a function names through a gate, following calls to local functions. */
function namedCapabilities(fn: Fn, fns: Map<string, Fn>, seen = new Set<Fn>()): string[] {
  if (seen.has(fn)) return [];
  seen.add(fn);
  const caps: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (GATES.has(name)) {
        const cap = node.arguments[name === "verifyOrgAccess" ? 1 : 2];
        if (cap && ts.isStringLiteral(cap)) caps.push(cap.text);
      } else if (fns.has(name)) {
        caps.push(...namedCapabilities(fns.get(name)!, fns, seen));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return caps;
}

const files = routeFiles(ROOT).filter((f) => !EXEMPT.has(path.relative(ROOT, f)));
const rows = files.flatMap((file) => {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const fns = localFunctions(sf);
  return [...handlers(sf, fns)].map(([method, fn]) => ({
    route: `${method} ${path.relative(ROOT, path.dirname(file)) || "."}`,
    caps: fn ? namedCapabilities(fn, fns) : [],
  }));
});

describe("organization route capabilities", () => {
  it("finds the org routes", () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it.each(rows)("$route names a capability", ({ caps }) => {
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(Object.keys(CAPABILITIES)).toContain(cap);
  });

  it("gates every terminal handler on an admin-only capability", () => {
    const terminal = rows.filter((r) => r.route.endsWith("/terminal"));
    expect(terminal.map((r) => r.route.split(" ")[0]).sort()).toEqual(["GET", "POST"]);
    for (const { caps } of terminal) {
      expect(caps).toContain("app.terminal");
      for (const cap of caps) expect(can("member", cap as Capability)).toBe(false);
    }
  });
});
