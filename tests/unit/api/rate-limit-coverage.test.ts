import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Every exported route handler under app/api is wrapped in withRateLimit, or listed here with a reason.
// SSE handlers must also carry withStreamCap.

const ROOT = path.join(process.cwd(), "app/api");
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const LIMITERS = new Set(["withRateLimit", "withStreamCap"]);

/** "METHOD path" → why it stays unlimited. */
const EXEMPT: Record<string, string> = {
  "GET health": "container and Traefik health check; a 429 would restart a healthy console",
};

/** GET handlers in a file that streams elsewhere (on POST) but answer JSON themselves. */
const JSON_GET: Record<string, string> = {
  "GET v1/organizations/[orgId]/apps/[appId]/rollback": "lists targets; only its POST streams",
};

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return /^route\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** Names of every function wrapped around the initializer, outermost first. */
function wrappers(expr: ts.Expression): string[] {
  const names: string[] = [];
  let cur: ts.Expression | undefined = expr;
  while (cur && ts.isCallExpression(cur)) {
    if (ts.isIdentifier(cur.expression)) names.push(cur.expression.text);
    cur = cur.arguments[0];
  }
  return names;
}

type Row = { id: string; wrappers: string[] | null; stream: boolean };

function rowsFor(file: string): Row[] {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const dir = path.relative(ROOT, path.dirname(file)) || ".";
  const stream = /text\/event-stream|createSSEResponse/.test(text);
  const rows: Row[] = [];
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(stmt) && exported && stmt.name && METHODS.has(stmt.name.text)) {
      rows.push({ id: `${stmt.name.text} ${dir}`, wrappers: null, stream });
    } else if (ts.isVariableStatement(stmt) && exported) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && METHODS.has(d.name.text) && d.initializer) {
          rows.push({ id: `${d.name.text} ${dir}`, wrappers: wrappers(d.initializer), stream });
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (METHODS.has(el.name.text)) rows.push({ id: `${el.name.text} ${dir}`, wrappers: null, stream });
      }
    }
  }
  return rows;
}

const files = routeFiles(ROOT);
const rows = files.flatMap(rowsFor);

describe("API rate-limit coverage", () => {
  it("finds the routes, so a bad path cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(rows.length).toBeGreaterThan(250);
    for (const f of files) expect(rowsFor(f).length, `${f} exports no handler`).toBeGreaterThan(0);
  });

  it.each(rows.map((r) => [r.id, r] as const))("%s is rate limited or exempt", (id, row) => {
    if (id in EXEMPT) return;
    const limited = row.wrappers?.some((w) => LIMITERS.has(w)) ?? false;
    expect(limited, `${id} needs withRateLimit(handler, { tier, key })`).toBe(true);
  });

  it.each(rows.filter((r) => r.stream && r.id.startsWith("GET ") && !(r.id in JSON_GET)).map((r) => [r.id, r] as const))(
    "%s caps concurrent streams",
    (_id, row) => {
      expect(row.wrappers).toContain("withStreamCap");
    },
  );

  it("lists only exemptions that still exist, each with a reason", () => {
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, why] of Object.entries(EXEMPT)) {
      expect(ids.has(id), `${id} is exempt but no longer exists`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
