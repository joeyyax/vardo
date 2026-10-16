import { commandName, toolFlags, type Flag, type Tool } from "./schema";

const MAX_LEFT = 30;

/** Text up to the end of the first sentence. */
export function firstSentence(text = ""): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** Word-wraps to `width` columns. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Cuts text to `width` columns with an ellipsis. */
export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`;
}

/** Two-column rows, with a long left cell pushing its text to the next line. */
function columns(rows: [string, string][], width: number, oneLine = false): string[] {
  const left = Math.min(MAX_LEFT, Math.max(...rows.map(([l]) => l.length)));
  const textWidth = Math.max(30, width - left - 4);
  const out: string[] = [];
  for (const [l, r] of rows) {
    const text = oneLine ? [truncate(r, textWidth)] : wrap(r, textWidth);
    const pad = " ".repeat(left + 4);
    if (l.length > left) out.push(`  ${l}`);
    else out.push(`  ${l.padEnd(left)}  ${text.shift() ?? ""}`.trimEnd());
    for (const t of text) out.push(`${pad}${t}`);
  }
  return out;
}

function flagLabel(f: Flag): string {
  if (f.kind === "boolean") return f.default === true ? `--[no-]${f.name}` : `--${f.name}`;
  const type = f.choices ? f.choices.join("|") : f.kind === "array" ? (f.item ?? "string") : f.kind === "integer" ? "number" : f.kind;
  return `--${f.name} <${type}>${f.kind === "array" ? "..." : ""}`;
}

function flagText(f: Flag): string {
  const notes: string[] = [];
  if (f.required) notes.push("required");
  else if (f.default !== undefined && !(f.kind === "boolean" && f.default === false) && !(Array.isArray(f.default) && f.default.length === 0)) {
    notes.push(`default ${typeof f.default === "string" ? f.default : JSON.stringify(f.default)}`);
  }
  const desc = (f.description ?? "").trim();
  if (f.nullable && !/\bnull\b/i.test(desc)) notes.push("null clears it");
  if (f.kind === "array") notes.push(f.item === "json" || f.item === "array" ? "repeat or pass a JSON array" : "repeat or comma-separate");
  return [desc, notes.length ? `(${notes.join("; ")})` : ""].filter(Boolean).join(" ");
}

export function commandHelp(tool: Tool, width: number): string {
  const name = commandName(tool.name);
  const flags = toolFlags(tool);
  const required = flags.filter((f) => f.required).map((f) => ` ${flagLabel(f)}`).join("");
  const optional = flags.some((f) => !f.required) ? " [flags]" : "";
  const lines = [`Usage: vardo ${name}${required}${optional}`, ""];
  if (tool.description) lines.push(...wrap(tool.description, Math.min(width, 80)), "");
  if (flags.length > 0) lines.push("Flags:", ...columns(flags.map((f) => [flagLabel(f), flagText(f)]), width), "");
  lines.push(
    "Global flags: --json, --use <name>.",
    "A flag that takes text also takes @file to read a file or - to read stdin.",
  );
  return `${lines.join("\n")}\n`;
}

export function rootHelp(opts: { tools?: Tool[]; note?: string; width: number }): string {
  const lines = ["Usage: vardo <command> [flags]", ""];

  if (opts.tools && opts.tools.length > 0) {
    const rows = [...opts.tools]
      .sort((a, b) => commandName(a.name).localeCompare(commandName(b.name)))
      .map((t): [string, string] => [commandName(t.name), firstSentence(t.description)]);
    lines.push("Commands:", ...columns(rows, opts.width, true), "");
  }
  if (opts.note) lines.push(opts.note, "");

  lines.push(
    "Instances:",
    ...columns(
      [
        ["login <url>", "Save an instance. Reads the API token from stdin or a prompt."],
        ["logout [name]", "Forget an instance."],
        ["instances", "List saved instances."],
        ["use <name>", "Make an instance the default."],
      ],
      opts.width,
    ),
    "",
    "Flags:",
    ...columns(
      [
        ["--json", "Print the structured result as JSON."],
        ["--use <name>", "Run against a saved instance instead of the default."],
        ["-h, --help", "Show help. `vardo <command> --help` shows a command's flags."],
        ["-v, --version", "Print the version."],
      ],
      opts.width,
    ),
    "",
    "VARDO_URL and VARDO_TOKEN override the saved instance.",
  );
  return `${lines.join("\n")}\n`;
}
