import pkg from "../package.json";
import { parseToolArgs, takeGlobal, UsageError, type GlobalFlags } from "./args";
import { readToolsCache, toolsCachePath, writeToolsCache } from "./cache";
import { configPath, instanceName, loadConfig, normalizeUrl, resolveTarget, saveConfig, type Target } from "./config";
import { commandHelp, rootHelp } from "./help";
import { callTool, CallError, listTools, type ToolResult } from "./mcp";
import { commandName, toolFlags, type Tool } from "./schema";

export const VERSION: string = pkg.version;

export type Io = {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  promptSecret: (label: string) => Promise<string>;
  readFile: (path: string) => string;
  fetch: typeof fetch;
  now: () => number;
  width: number;
};

const USAGE: Record<string, string> = {
  login: "Usage: vardo login <url> [--name <name>]\n\nReads the API token from stdin or a hidden prompt.\n",
  logout: "Usage: vardo logout [name]\n\nForgets the instance, the default one when no name is given.\n",
  instances: "Usage: vardo instances [--json]\n",
  use: "Usage: vardo use <name>\n\nMakes a saved instance the default.\n",
};

/** Runs the CLI and returns the exit code: 0 ok, 1 failed call or tool error, 2 usage error. */
export async function run(io: Io): Promise<number> {
  try {
    return await main(io);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

async function main(io: Io): Promise<number> {
  const globals: GlobalFlags = { json: false, help: false };
  let i = 0;
  let command: string | undefined;
  while (i < io.argv.length) {
    const taken = takeGlobal(io.argv, i, globals);
    if (taken) {
      i += taken;
      continue;
    }
    const tok = io.argv[i++];
    if (tok === "--version" || tok === "-v") {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (tok.startsWith("-")) throw new UsageError(`Unknown flag ${tok}. Run \`vardo --help\`.`);
    command = tok;
    break;
  }
  const rest = io.argv.slice(i);
  const wantsHelp = globals.help || rest.includes("--help") || rest.includes("-h");

  if (command === "help") {
    if (!rest[0]) return showRootHelp(io, globals);
    return main({ ...io, argv: [rest[0], "--help"] });
  }
  if (!command) return showRootHelp(io, globals);

  if (command in USAGE && wantsHelp) {
    io.stdout(USAGE[command]);
    return 0;
  }
  if (command === "login") return login(io, rest);
  if (command === "logout") return logout(io, rest);
  if (command === "instances") return instances(io, rest, globals);
  if (command === "use") return setDefault(io, rest);
  return runTool(io, command, rest, globals, wantsHelp);
}

async function getTools(io: Io, target: Target, fresh = false): Promise<{ tools: Tool[]; cached: boolean }> {
  const path = toolsCachePath(io.env, target);
  const cached = fresh ? null : readToolsCache(path, io.now());
  if (cached) return { tools: cached, cached: true };
  const tools = await listTools(target, { fetch: io.fetch, userAgent: `vardo-cli/${VERSION}` });
  writeToolsCache(path, tools, io.now());
  return { tools, cached: false };
}

function findTool(tools: Tool[], command: string): Tool | undefined {
  return tools.find((t) => commandName(t.name) === command || t.name === command);
}

/** `--use` given after the command, needed before the tool's flags are known. */
function peekUse(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--use") return argv[i + 1];
    if (argv[i].startsWith("--use=")) return argv[i].slice(6);
  }
  return undefined;
}

async function showRootHelp(io: Io, globals: GlobalFlags): Promise<number> {
  let tools: Tool[] | undefined;
  let note: string | undefined;
  try {
    const target = resolveTarget(loadConfig(configPath(io.env)), io.env, globals.use);
    tools = (await getTools(io, target)).tools;
  } catch (err) {
    note = err instanceof CallError ? `Couldn't load commands: ${err.message}` : "Log in to see the commands: vardo login <url>";
  }
  io.stdout(rootHelp({ tools, note, width: io.width }));
  return 0;
}

async function runTool(io: Io, command: string, rest: string[], globals: GlobalFlags, wantsHelp: boolean): Promise<number> {
  const target = resolveTarget(loadConfig(configPath(io.env)), io.env, globals.use ?? peekUse(rest));
  let { tools, cached } = await getTools(io, target);
  let tool = findTool(tools, command);
  if (!tool && cached) {
    ({ tools, cached } = await getTools(io, target, true));
    tool = findTool(tools, command);
  }
  if (!tool) throw new UsageError(`Unknown command "${command}". Run \`vardo --help\`.`);

  if (wantsHelp) {
    io.stdout(commandHelp(tool, io.width));
    return 0;
  }

  let parsed;
  try {
    parsed = await parseToolArgs(rest, toolFlags(tool), { readFile: io.readFile, readStdin: io.readStdin });
  } catch (err) {
    if (err instanceof UsageError) throw new UsageError(`${err.message} Run \`vardo ${command} --help\`.`);
    throw err;
  }

  const result = await callTool(target, tool.name, parsed.args, { fetch: io.fetch, userAgent: `vardo-cli/${VERSION}` });
  return printResult(io, result, globals.json || parsed.json);
}

function isJson(text: string): boolean {
  if (!/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The result's content as text. A JSON block next to prose is the machine copy and is left out. */
export function resultText(result: ToolResult): string {
  let content = result.content ?? [];
  if (content.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  if (content.some((c) => c.type === "text" && !isJson(c.text ?? ""))) {
    content = content.filter((c) => c.type !== "text" || !isJson(c.text ?? ""));
  }
  return content
    .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`))
    .join("\n");
}

/** The structured content, else the tool's one JSON text block, else the raw result. */
export function resultJson(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length === 1 && content[0].type === "text" && isJson(content[0].text ?? "")) return JSON.parse(content[0].text!);
  return result;
}

/** A failed result's message, unwrapped from `{"error": "..."}`. */
export function errorText(result: ToolResult): string {
  const text = resultText(result);
  if (isJson(text)) {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  }
  return text || "The tool failed.";
}

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function printResult(io: Pick<Io, "stdout" | "stderr">, result: ToolResult, json: boolean): number {
  if (result.isError) {
    io.stderr(line(errorText(result)));
    return 1;
  }
  if (json) io.stdout(`${JSON.stringify(resultJson(result), null, 2)}\n`);
  else {
    const text = resultText(result);
    if (text) io.stdout(line(text));
  }
  return 0;
}

async function login(io: Io, rest: string[]): Promise<number> {
  let url: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--name") name = rest[++i];
    else if (tok.startsWith("--name=")) name = tok.slice(7);
    else if (tok.startsWith("-")) throw new UsageError(`Unknown flag ${tok}.\n\n${USAGE.login}`);
    else if (url) throw new UsageError(`Unexpected argument "${tok}".\n\n${USAGE.login}`);
    else url = tok;
  }
  if (!url) throw new UsageError(USAGE.login.trimEnd());
  if (name === "") throw new UsageError("--name needs a value.");

  const normalized = normalizeUrl(url);
  const token = (io.stdinIsTTY ? await io.promptSecret("API token: ") : await io.readStdin()).trim();
  if (!token) throw new UsageError("No token given.");

  const instance = { name: name ?? instanceName(normalized), url: normalized, token };
  const { tools } = await getTools(io, instance, true);

  const path = configPath(io.env);
  const config = loadConfig(path);
  config.instances[instance.name] = { url: instance.url, token };
  if (!config.default || !config.instances[config.default]) config.default = instance.name;
  saveConfig(path, config);

  const isDefault = config.default === instance.name;
  io.stdout(
    `Logged in to ${instance.name}${isDefault ? " (default)" : ""}. ${tools.length} commands available.\n` +
      (isDefault ? "" : `Run \`vardo use ${instance.name}\` to make it the default.\n`),
  );
  return 0;
}

async function logout(io: Io, rest: string[]): Promise<number> {
  const path = configPath(io.env);
  const config = loadConfig(path);
  const name = rest[0] ?? config.default;
  if (!name) throw new UsageError("Not logged in.");
  if (!config.instances[name]) throw new UsageError(`No saved instance named ${name}. Run \`vardo instances\`.`);
  delete config.instances[name];
  if (config.default === name) config.default = Object.keys(config.instances)[0];
  saveConfig(path, config);
  io.stdout(`Logged out of ${name}.\n`);
  return 0;
}

async function instances(io: Io, rest: string[], globals: GlobalFlags): Promise<number> {
  const config = loadConfig(configPath(io.env));
  const entries = Object.entries(config.instances);
  if (globals.json || rest.includes("--json")) {
    const list = entries.map(([name, i]) => ({ name, url: i.url, default: name === config.default }));
    io.stdout(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    io.stdout("No saved instances. Run `vardo login <url>`.\n");
    return 0;
  }
  const width = Math.max(...entries.map(([name]) => name.length));
  for (const [name, i] of entries) io.stdout(`${name === config.default ? "*" : " "} ${name.padEnd(width)}  ${i.url}\n`);
  return 0;
}

async function setDefault(io: Io, rest: string[]): Promise<number> {
  const name = rest[0];
  if (!name) throw new UsageError(USAGE.use.trimEnd());
  const path = configPath(io.env);
  const config = loadConfig(path);
  if (!config.instances[name]) throw new UsageError(`No saved instance named ${name}. Run \`vardo instances\`.`);
  config.default = name;
  saveConfig(path, config);
  io.stdout(`${name} is now the default.\n`);
  return 0;
}
