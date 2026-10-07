import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CAPABILITIES } from "@/lib/auth/permissions";

// Every MCP tool names the capability it needs through the scope helpers.

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

function capabilitiesIn(node: ts.Node): string[] {
  const caps: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && GATES.has(n.expression.text)) {
      for (const arg of n.arguments) if (ts.isStringLiteral(arg)) caps.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return caps;
}

const tools = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((file) => {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const found: { tool: string; caps: string[] }[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "tool" &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        const handler = n.arguments[n.arguments.length - 1];
        found.push({ tool: n.arguments[0].text, caps: capabilitiesIn(handler) });
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

  it.each(tools)("$tool names a capability", ({ caps }) => {
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(KNOWN).toContain(cap);
  });
});
