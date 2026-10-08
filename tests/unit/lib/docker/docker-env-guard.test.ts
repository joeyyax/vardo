import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

// Every docker or builder process gets an explicit env, so the console's secrets never reach compose interpolation.

const ROOT = process.cwd();
const SCAN = ["lib", "app"];

const EXEC_FNS = new Set([
  "exec",
  "execAsync",
  "execSync",
  "execFile",
  "execFileAsync",
  "execFileAsyncInternal",
  "execFileSync",
  "spawn",
  "spawnSync",
  "nodeSpawn",
  "spawnStream",
]);
const DOCKER_COMMANDS = new Set(["docker", "nixpacks", "railpack"]);

// Calls whose command is a variable. Each must still pass an env.
const VARIABLE_COMMAND_FILES = new Set(["lib/gpu/providers/nvidia.ts", "lib/docker/deploy-steps/prepare-repo.ts"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** "docker" for `"docker"` and for shell strings starting `docker `; null when the command isn't a literal. */
function literalCommand(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text.split(" ")[0];
  if (ts.isTemplateExpression(arg)) return arg.head.text.split(" ")[0];
  return null;
}

function hasEnv(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "env",
      ),
  );
}

interface Offender {
  file: string;
  line: number;
  text: string;
}

/** Docker exec and spawn calls in `source` with no `env` option. */
function findOffenders(file: string, source: string): { checked: number; offenders: Offender[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const offenders: Offender[] = [];
  let checked = 0;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && EXEC_FNS.has(name)) {
        const command = literalCommand(node.arguments[0]);
        const isDocker = command !== null && DOCKER_COMMANDS.has(command);
        const isVariable = command === null && ts.isIdentifier(node.arguments[0] ?? node) && VARIABLE_COMMAND_FILES.has(file);
        if (isDocker || isVariable) {
          checked++;
          if (!hasEnv(node)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            offenders.push({ file, line: line + 1, text: node.getText().split("\n")[0] });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { checked, offenders };
}

describe("docker exec env guard", () => {
  const files = SCAN.flatMap((d) => sourceFiles(join(ROOT, d))).filter((f) => !f.endsWith("lib/utils/exec.ts"));

  it("flags a docker call with no env and passes one with it", () => {
    const bad = findOffenders("x.ts", `execFileAsync("docker", ["compose", "up"], { cwd: "/x" });`);
    const shell = findOffenders("x.ts", "execAsync(`docker run ${v}`, { timeout: 1 });");
    const good = findOffenders("x.ts", `execFileAsync("docker", ["ps"], { env: dockerEnv() });`);
    const git = findOffenders("x.ts", `execFileAsync("git", ["status"]);`);
    expect(bad.offenders).toHaveLength(1);
    expect(shell.offenders).toHaveLength(1);
    expect(good).toEqual({ checked: 1, offenders: [] });
    expect(git.checked).toBe(0);
  });

  it("every docker exec and spawn passes env", () => {
    let checked = 0;
    const offenders: Offender[] = [];
    for (const full of files) {
      const result = findOffenders(relative(ROOT, full), readFileSync(full, "utf8"));
      checked += result.checked;
      offenders.push(...result.offenders);
    }
    // Guards against a bad path making this pass vacuously.
    expect(checked).toBeGreaterThan(100);
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.text}`)).toEqual([]);
  });
});
