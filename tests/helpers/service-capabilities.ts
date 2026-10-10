import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Capabilities each lib/app-services export checks through authorize(), following calls between services.

const DIR = path.resolve(__dirname, "../../lib/app-services");

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function functionsIn(sf: ts.SourceFile): Map<string, Fn> {
  const fns = new Map<string, Fn>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) fns.set(stmt.name.text, stmt);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          fns.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return fns;
}

/** Service function name to the capabilities it authorizes. Names are unique across lib/app-services. */
export function serviceCapabilities(): Map<string, string[]> {
  const fns = new Map<string, Fn>();
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(path.join(DIR, file), "utf8"), ts.ScriptTarget.Latest, true);
    for (const [name, fn] of functionsIn(sf)) fns.set(name, fn);
  }

  const resolve = (fn: Fn, seen: Set<Fn>): string[] => {
    if (seen.has(fn)) return [];
    seen.add(fn);
    const caps: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === "authorize") {
          const cap = node.arguments[1];
          if (cap && ts.isStringLiteral(cap)) caps.push(cap.text);
        } else if (fns.has(name)) {
          caps.push(...resolve(fns.get(name)!, seen));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    return caps;
  };

  return new Map([...fns].map(([name, fn]) => [name, resolve(fn, new Set())]));
}
