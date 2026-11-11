// NUT network protocol: line framing, tokenizing and reply parsing. No I/O.

export const NUT_DEFAULT_PORT = 3493;

/** An `ERR <CODE>` reply. A bare `ERR` reads as UNKNOWN. */
export class NutError extends Error {
  constructor(readonly code: string) {
    super(`NUT server replied ERR ${code}`);
    this.name = "NutError";
  }
}

/** A reply that doesn't follow the protocol. */
export class NutProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NutProtocolError";
  }
}

/** Splits a byte stream into lines; keeps the partial tail until its newline arrives. */
export class LineBuffer {
  private tail = "";

  constructor(private readonly maxLine = 64 * 1024) {}

  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const parts = text.split("\n");
    this.tail = parts.pop() ?? "";
    if (this.tail.length > this.maxLine) throw new NutProtocolError("Line too long");
    return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  }

  get pending(): boolean {
    return this.tail.length > 0;
  }
}

/** Words of a reply line; double-quoted words keep spaces and take backslash escapes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    let word = "";
    if (c === '"') {
      i++;
      let closed = false;
      while (i < line.length) {
        const ch = line[i];
        if (ch === "\\") {
          if (i + 1 >= line.length) break;
          word += line[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        word += ch;
        i++;
      }
      if (!closed) throw new NutProtocolError(`Unterminated quote in: ${line}`);
    } else {
      while (i < line.length && line[i] !== " " && line[i] !== "\t") word += line[i++];
    }
    out.push(word);
  }
  return out;
}

/** Quotes an argument for a command when it needs it. */
export function quoteArg(value: string): string {
  if (/[\r\n]/.test(value)) throw new NutProtocolError("Arguments can't contain line breaks");
  if (value !== "" && !/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** The error code when the line is an ERR reply, else null. */
export function errorCode(line: string): string | null {
  const words = tokenize(line);
  if (words[0] !== "ERR") return null;
  return words[1] || "UNKNOWN";
}

/** Throws the NutError for an ERR line. */
export function throwIfError(line: string): void {
  const code = errorCode(line);
  if (code) throw new NutError(code);
}

/** Collects one reply: a single line, or a `BEGIN LIST` … `END LIST` block. */
export class ReplyCollector {
  private lines: string[] = [];
  private inList = false;

  constructor(private readonly list: boolean) {}

  /** The finished reply once the line completes it, else null. */
  feed(line: string): string[] | null {
    if (!this.list) return [line];
    if (!this.inList) {
      if (errorCode(line)) return [line];
      if (!line.startsWith("BEGIN LIST ")) throw new NutProtocolError(`Expected BEGIN LIST, got: ${line}`);
      this.inList = true;
      this.lines.push(line);
      return null;
    }
    this.lines.push(line);
    return line.startsWith("END LIST ") ? this.lines : null;
  }
}

function listBody(lines: string[], header: string): string[][] {
  throwIfError(lines[0] ?? "");
  const begin = tokenize(lines[0] ?? "");
  const end = tokenize(lines.at(-1) ?? "");
  const want = tokenize(header);
  const same = (words: string[], offset: number) => want.every((w, i) => words[offset + i] === w);
  if (begin[0] !== "BEGIN" || !same(begin, 1)) throw new NutProtocolError(`Expected BEGIN ${header}`);
  if (end[0] !== "END" || !same(end, 1)) throw new NutProtocolError(`Expected END ${header}`);
  return lines.slice(1, -1).map(tokenize);
}

export type NutUps = { name: string; description: string };

/** `LIST UPS` reply. */
export function parseListUps(lines: string[]): NutUps[] {
  return listBody(lines, "LIST UPS")
    .filter((w) => w[0] === "UPS" && w.length >= 2)
    .map((w) => ({ name: w[1], description: w[2] ?? "" }));
}

/** `LIST VAR <ups>` reply as name → value. */
export function parseListVar(lines: string[], ups: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const w of listBody(lines, `LIST VAR ${quoteArg(ups)}`)) {
    if (w[0] === "VAR" && w[1] === ups && w.length >= 4) vars[w[2]] = w[3];
  }
  return vars;
}

/** `GET VAR <ups> <var>` reply value. */
export function parseGetVar(line: string, ups: string, name: string): string {
  throwIfError(line);
  const w = tokenize(line);
  if (w[0] !== "VAR" || w[1] !== ups || w[2] !== name || w.length < 4) throw new NutProtocolError(`Unexpected reply: ${line}`);
  return w[3];
}

/** An `OK` reply, else the ERR it carries. */
export function expectOk(line: string): void {
  throwIfError(line);
  if (!line.startsWith("OK")) throw new NutProtocolError(`Expected OK, got: ${line}`);
}
