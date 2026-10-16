import type { Flag, Kind } from "./schema";

/** A mistake in how the command was typed; exits 2. */
export class UsageError extends Error {}

export type TextSource = {
  readFile: (path: string) => string;
  readStdin: () => Promise<string>;
};

export type GlobalFlags = { json: boolean; help: boolean; use?: string };

export type ParsedArgs = GlobalFlags & { args: Record<string, unknown> };

/** Consumes a global flag at argv[i]; returns how many tokens it took, 0 when it isn't one. */
export function takeGlobal(argv: string[], i: number, globals: GlobalFlags): number {
  const tok = argv[i];
  if (tok === "--json") {
    globals.json = true;
    return 1;
  }
  if (tok === "--help" || tok === "-h") {
    globals.help = true;
    return 1;
  }
  if (tok.startsWith("--use=")) {
    globals.use = tok.slice(6);
    return 1;
  }
  if (tok === "--use") {
    if (argv[i + 1] === undefined) throw new UsageError("--use needs an instance name.");
    globals.use = argv[i + 1];
    return 2;
  }
  return 0;
}

function stripNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/** Resolves `-` to stdin, `@path` to a file and `@@x` to a literal `@x`. */
async function readText(raw: string, source: TextSource, state: { stdin: boolean }): Promise<string> {
  if (raw === "-") {
    if (state.stdin) throw new UsageError("Only one flag can read stdin.");
    state.stdin = true;
    return stripNewline(await source.readStdin());
  }
  if (raw.startsWith("@@")) return raw.slice(1);
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      return stripNewline(source.readFile(path));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new UsageError(`Can't read ${path}${code ? ` (${code})` : ""}.`);
    }
  }
  return raw;
}

function parseJson(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--${name} takes JSON: ${(err as Error).message}`);
  }
}

function scalar(name: string, kind: Kind, choices: Flag["choices"], text: string): unknown {
  let value: unknown = text;
  if (kind === "number" || kind === "integer") {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${name} takes a number, not "${text}".`);
    if (kind === "integer" && !Number.isInteger(n)) throw new UsageError(`--${name} takes a whole number, not "${text}".`);
    value = n;
  } else if (kind === "json" || kind === "array") {
    value = parseJson(name, text);
  } else if (kind === "boolean") {
    if (text !== "true" && text !== "false") throw new UsageError(`--${name} takes true or false.`);
    value = text === "true";
  }
  if (choices && !choices.includes(value as string | number)) {
    throw new UsageError(`--${name} takes one of ${choices.join(", ")}.`);
  }
  return value;
}

/** Turns one flag's raw texts into its value. */
export function coerce(flag: Flag, texts: string[]): unknown {
  if (flag.nullable && texts.length === 1 && texts[0] === "null") return null;
  if (flag.kind !== "array") return scalar(flag.name, flag.kind, flag.choices, texts[0]);

  const item = flag.item ?? "string";
  const out: unknown[] = [];
  for (const text of texts) {
    if (text.trim().startsWith("[")) {
      const parsed = parseJson(flag.name, text);
      if (!Array.isArray(parsed)) throw new UsageError(`--${flag.name} takes a JSON array.`);
      out.push(...parsed);
    } else if (item === "json" || item === "array") {
      out.push(parseJson(flag.name, text));
    } else {
      for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
        out.push(scalar(flag.name, item, flag.choices, part));
      }
    }
  }
  return out;
}

/** Parses a tool command's flags into its arguments. */
export async function parseToolArgs(argv: string[], flags: Flag[], source: TextSource): Promise<ParsedArgs> {
  const byName = new Map(flags.map((f) => [f.name, f]));
  const globals: GlobalFlags = { json: false, help: false };
  const raw = new Map<Flag, string[] | boolean>();

  for (let i = 0; i < argv.length; ) {
    const taken = takeGlobal(argv, i, globals);
    if (taken) {
      i += taken;
      continue;
    }
    const tok = argv[i++];
    if (!tok.startsWith("--") || tok === "--") throw new UsageError(`Unexpected argument "${tok}".`);

    const eq = tok.indexOf("=");
    const name = tok.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    const flag = byName.get(name);

    if (!flag && name.startsWith("no-") && byName.get(name.slice(3))?.kind === "boolean" && inline === undefined) {
      raw.set(byName.get(name.slice(3))!, false);
      continue;
    }
    if (!flag) throw new UsageError(`Unknown flag --${name}.`);

    if (flag.kind === "boolean") {
      raw.set(flag, inline === undefined ? true : (scalar(name, "boolean", undefined, inline) as boolean));
      continue;
    }

    const value = inline ?? argv[i++];
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    const prev = raw.get(flag);
    if (Array.isArray(prev) && flag.kind !== "array") throw new UsageError(`--${name} was given twice.`);
    raw.set(flag, [...(Array.isArray(prev) ? prev : []), value]);
  }

  if (globals.help) return { ...globals, args: {} };

  const missing = flags.filter((f) => f.required && !raw.has(f)).map((f) => `--${f.name}`);
  if (missing.length > 0) throw new UsageError(`Missing ${missing.join(", ")}.`);

  const state = { stdin: false };
  const args: Record<string, unknown> = {};
  for (const [flag, value] of raw) {
    if (typeof value === "boolean") {
      args[flag.prop] = value;
      continue;
    }
    const texts: string[] = [];
    for (const v of value) texts.push(await readText(v, source, state));
    args[flag.prop] = coerce(flag, texts);
  }
  return { ...globals, args };
}
