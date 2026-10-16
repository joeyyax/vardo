import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { coerce, parseToolArgs, UsageError } from "@/packages/cli/src/args";
import { toolFlags, type Tool } from "@/packages/cli/src/schema";

const tool: Tool = {
  name: "vardo_test",
  inputSchema: {
    type: "object",
    properties: {
      appId: { type: "string" },
      content: { type: "string" },
      limit: { type: "integer" },
      ratio: { type: "number" },
      rebuild: { type: "string", enum: ["force", "no-cache"] },
      enabled: { type: "boolean", default: true },
      deleteVolumes: { type: "boolean" },
      keepVolumes: { type: "array", items: { type: "string" } },
      headers: { type: "array", items: { type: "object" } },
      config: { type: "object" },
      redirectTo: { anyOf: [{ type: "string" }, { type: "null" }] },
      redirectCode: { anyOf: [{ type: "number", const: 301 }, { type: "number", const: 302 }] },
    },
    required: ["appId"],
  },
};
const flags = toolFlags(tool);

function source(stdin = "") {
  return { readFile: (p: string) => readFileSync(p, "utf8"), readStdin: vi.fn(async () => stdin) };
}

const parse = (argv: string[], src = source()) => parseToolArgs(argv, flags, src);

describe("parseToolArgs", () => {
  it("maps kebab flags back to properties", async () => {
    const r = await parse(["--app-id", "a1", "--content=hello"]);
    expect(r.args).toEqual({ appId: "a1", content: "hello" });
  });

  it("parses numbers and rejects bad ones", async () => {
    expect((await parse(["--app-id", "a", "--limit", "5", "--ratio", "0.5"])).args).toMatchObject({ limit: 5, ratio: 0.5 });
    await expect(parse(["--app-id", "a", "--limit", "abc"])).rejects.toThrow('--limit takes a number, not "abc".');
    await expect(parse(["--app-id", "a", "--limit", "1.5"])).rejects.toThrow("--limit takes a whole number");
    await expect(parse(["--app-id", "a", "--limit", ""])).rejects.toThrow("--limit takes a number");
  });

  it("checks enum choices, string and numeric", async () => {
    expect((await parse(["--app-id", "a", "--rebuild", "force"])).args.rebuild).toBe("force");
    await expect(parse(["--app-id", "a", "--rebuild", "nope"])).rejects.toThrow("--rebuild takes one of force, no-cache.");
    expect((await parse(["--app-id", "a", "--redirect-code", "302"])).args.redirectCode).toBe(302);
    await expect(parse(["--app-id", "a", "--redirect-code", "303"])).rejects.toThrow("takes one of 301, 302");
  });

  it("treats booleans as switches with --no- and =value forms", async () => {
    expect((await parse(["--app-id", "a", "--delete-volumes"])).args.deleteVolumes).toBe(true);
    expect((await parse(["--app-id", "a", "--no-enabled"])).args.enabled).toBe(false);
    expect((await parse(["--app-id", "a", "--enabled=false"])).args.enabled).toBe(false);
    await expect(parse(["--app-id", "a", "--enabled=maybe"])).rejects.toThrow("--enabled takes true or false.");
  });

  it("collects arrays from repeats, comma lists and JSON", async () => {
    expect((await parse(["--app-id", "a", "--keep-volumes", "db", "--keep-volumes", "cache,uploads"])).args.keepVolumes).toEqual([
      "db",
      "cache",
      "uploads",
    ]);
    expect((await parse(["--app-id", "a", "--keep-volumes", '["a,b"]'])).args.keepVolumes).toEqual(["a,b"]);
    expect(
      (await parse(["--app-id", "a", "--headers", '{"name":"X"}', "--headers", '{"name":"Y","value":"1"}'])).args.headers,
    ).toEqual([{ name: "X" }, { name: "Y", value: "1" }]);
  });

  it("parses objects as JSON", async () => {
    expect((await parse(["--app-id", "a", "--config", '{"url":"https://x"}'])).args.config).toEqual({ url: "https://x" });
    await expect(parse(["--app-id", "a", "--config", "{nope"])).rejects.toThrow("--config takes JSON");
  });

  it("sends null for nullable flags", async () => {
    expect((await parse(["--app-id", "a", "--redirect-to", "null"])).args.redirectTo).toBeNull();
    await expect(parse(["--app-id", "a", "--content", "null"])).resolves.toMatchObject({ args: { content: "null" } });
  });

  it("reports missing, unknown, repeated and valueless flags", async () => {
    await expect(parse([])).rejects.toThrow("Missing --app-id.");
    await expect(parse(["--app-id", "a", "--nope", "1"])).rejects.toThrow("Unknown flag --nope.");
    await expect(parse(["--app-id", "a", "--app-id", "b"])).rejects.toThrow("--app-id was given twice.");
    await expect(parse(["--app-id"])).rejects.toThrow("--app-id needs a value.");
    await expect(parse(["--app-id", "a", "stray"])).rejects.toThrow('Unexpected argument "stray".');
    await expect(parse([])).rejects.toBeInstanceOf(UsageError);
  });

  it("picks up global flags anywhere", async () => {
    const r = await parse(["--json", "--app-id", "a", "--use", "home"]);
    expect(r).toMatchObject({ json: true, use: "home", args: { appId: "a" } });
  });

  it("skips required checks for --help", async () => {
    expect((await parse(["--help"])).help).toBe(true);
  });
});

describe("text sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "vardo-cli-args-"));

  it("reads @file without its trailing newline", async () => {
    const file = join(dir, "env");
    writeFileSync(file, "A=1\nB=2\n");
    expect((await parse(["--app-id", "a", "--content", `@${file}`])).args.content).toBe("A=1\nB=2");
  });

  it("reads - from stdin", async () => {
    const src = source("SECRET=x\n");
    expect((await parse(["--app-id", "a", "--content", "-"], src)).args.content).toBe("SECRET=x");
    expect(src.readStdin).toHaveBeenCalledTimes(1);
  });

  it("allows stdin once", async () => {
    await expect(parse(["--app-id", "-", "--content", "-"], source("x"))).rejects.toThrow("Only one flag can read stdin.");
  });

  it("keeps @@ as a literal @", async () => {
    expect((await parse(["--app-id", "@@channel"])).args.appId).toBe("@channel");
  });

  it("reports a missing file", async () => {
    await expect(parse(["--app-id", `@${join(dir, "missing")}`])).rejects.toThrow(/Can't read .*missing \(ENOENT\)\./);
  });

  it("reads JSON flags from files too", async () => {
    const file = join(dir, "config.json");
    writeFileSync(file, '{"topic":"alerts"}\n');
    expect((await parse(["--app-id", "a", "--config", `@${file}`])).args.config).toEqual({ topic: "alerts" });
  });
});

describe("coerce", () => {
  it("rejects a JSON array flag that isn't an array", () => {
    const keep = flags.find((f) => f.name === "keep-volumes")!;
    expect(() => coerce(keep, ["[1"])).toThrow("takes JSON");
  });
});
