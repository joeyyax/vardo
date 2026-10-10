import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CAPABILITIES } from "@/lib/auth/permissions";

// Every MCP tool names the capability it needs through the scope helpers, or checks the instance-admin scope.

const DIR = path.resolve(__dirname, "../../../../lib/mcp/tools");
const GATES = new Set([
  "canAccessOrg",
  "accessibleOrgIds",
  "resolveTargetOrg",
  "resolveAppOrg",
  "resolveProjectOrg",
  "resolveOrgPreview",
]);
const KNOWN = new Set(Object.keys(CAPABILITIES));
const ADMIN_GATE = "canAdminInstance";

function gatesIn(node: ts.Node): { caps: string[]; adminGated: boolean } {
  const caps: string[] = [];
  let adminGated = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (GATES.has(n.expression.text)) {
        for (const arg of n.arguments) if (ts.isStringLiteral(arg)) caps.push(arg.text);
      }
      if (n.expression.text === ADMIN_GATE) adminGated = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { caps, adminGated };
}

const tools = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((file) => {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const found: { tool: string; caps: string[]; adminGated: boolean }[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "tool" &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        const handler = n.arguments[n.arguments.length - 1];
        found.push({ tool: n.arguments[0].text, ...gatesIn(handler) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  });

describe("MCP tool capabilities", () => {
  it("finds the tools", () => {
    expect(tools.length).toBeGreaterThan(20);
  });

  it.each(tools)("$tool names a capability or checks the admin scope", ({ caps, adminGated }) => {
    expect(caps.length > 0 || adminGated).toBe(true);
    for (const cap of caps) expect(KNOWN).toContain(cap);
  });
});
