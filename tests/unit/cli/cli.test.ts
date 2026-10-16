import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { errorText, resultJson, resultText, run, type Io } from "@/packages/cli/src/cli";
import { saveConfig } from "@/packages/cli/src/config";
import type { Tool } from "@/packages/cli/src/schema";

const tools: Tool[] = [
  {
    name: "vardo_list_apps",
    description: "List all apps in the organization. Returns more.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", default: 50 }, instance: { type: "string" } } },
  },
  {
    name: "vardo_set_env_vars",
    description: "Set the environment variables for an app.",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string", description: "The app ID" }, content: { type: "string" } },
      required: ["appId", "content"],
    },
  },
  { name: "vardo_doctor", description: "Check this instance.", inputSchema: { type: "object", properties: {} } },
];

type CallHandler = (name: string, args: Record<string, unknown>) => unknown;

function setup(opts: { onCall?: CallHandler; stdin?: string; loggedIn?: boolean; status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vardo-cli-run-"));
  const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache") };
  if (opts.loggedIn !== false) {
    saveConfig(join(env.XDG_CONFIG_HOME, "vardo", "config.json"), {
      default: "vardo.example.com",
      instances: { "vardo.example.com": { url: "https://vardo.example.com", token: "tok" } },
    });
  }
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(init.body as string);
    calls.push({ method, params });
    if (opts.status) return new Response("{}", { status: opts.status });
    const result = method === "tools/list" ? { tools } : opts.onCall?.(params.name, params.arguments) ?? { content: [] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const out: string[] = [];
  const err: string[] = [];
  const exec = (...argv: string[]) => {
    const io: Io = {
      argv,
      env,
      stdout: (t) => void out.push(t),
      stderr: (t) => void err.push(t),
      stdinIsTTY: false,
      readStdin: async () => opts.stdin ?? "",
      promptSecret: async () => "",
      readFile: (p) => readFileSync(p, "utf8"),
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 1_000_000,
      width: 100,
    };
    return run(io);
  };
  return { exec, calls, fetch, env, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("run: tool commands", () => {
  it("prints the tool's text and exits 0", async () => {
    const t = setup({ onCall: () => ({ content: [{ type: "text", text: "PASS  Worker up" }] }) });
    expect(await t.exec("doctor")).toBe(0);
    expect(t.stdout()).toBe("PASS  Worker up\n");
    expect(t.calls.at(-1)).toEqual({ method: "tools/call", params: { name: "vardo_doctor", arguments: {} } });
  });

  it("passes parsed flags and --instance through", async () => {
    const t = setup();
    expect(await t.exec("list-apps", "--limit", "2", "--instance", "jy0")).toBe(0);
    expect(t.calls.at(-1)?.params).toEqual({ name: "vardo_list_apps", arguments: { limit: 2, instance: "jy0" } });
  });

  it("reads a secret from stdin", async () => {
    const t = setup({ stdin: "API_KEY=s3cret\n" });
    expect(await t.exec("set-env-vars", "--app-id", "a1", "--content", "-")).toBe(0);
    expect(t.calls.at(-1)?.params.arguments).toEqual({ appId: "a1", content: "API_KEY=s3cret" });
  });

  it("leaves out the JSON copy next to prose", async () => {
    const t = setup({
      onCall: () => ({ content: [{ type: "text", text: "PASS  ok" }, { type: "text", text: '{"status":"pass"}' }], structuredContent: { status: "pass" } }),
    });
    await t.exec("doctor");
    expect(t.stdout()).toBe("PASS  ok\n");
  });

  it("prints structured content with --json", async () => {
    const t = setup({ onCall: () => ({ content: [{ type: "text", text: "x" }], structuredContent: { status: "pass" } }) });
    expect(await t.exec("--json", "doctor")).toBe(0);
    expect(JSON.parse(t.stdout())).toEqual({ status: "pass" });
  });

  it("prints a JSON text block parsed with --json, after the command too", async () => {
    const t = setup({ onCall: () => ({ content: [{ type: "text", text: '{"apps":[]}' }] }) });
    expect(await t.exec("list-apps", "--json")).toBe(0);
    expect(JSON.parse(t.stdout())).toEqual({ apps: [] });
  });

  it("exits 1 with the error on stderr when the result is an error", async () => {
    const t = setup({ onCall: () => ({ content: [{ type: "text", text: '{"error":"App not found"}' }], isError: true }) });
    expect(await t.exec("set-env-vars", "--app-id", "x", "--content", "y")).toBe(1);
    expect(t.stderr()).toBe("App not found\n");
    expect(t.stdout()).toBe("");
  });

  it("exits 1 when the call fails", async () => {
    const t = setup({ status: 401 });
    expect(await t.exec("doctor")).toBe(1);
    expect(t.stderr()).toContain("rejected the token");
  });

  it("exits 2 on usage errors with a pointer to help", async () => {
    const t = setup();
    expect(await t.exec("set-env-vars", "--app-id", "a")).toBe(2);
    expect(t.stderr()).toBe("Missing --content. Run `vardo set-env-vars --help`.\n");
    expect(await t.exec("nope")).toBe(2);
    expect(await t.exec("--bogus")).toBe(2);
  });

  it("exits 2 when not logged in", async () => {
    const t = setup({ loggedIn: false });
    expect(await t.exec("doctor")).toBe(2);
    expect(t.stderr()).toContain("Not logged in. Run `vardo login <url>`.");
  });

  it("accepts the full tool name", async () => {
    const t = setup();
    expect(await t.exec("vardo_doctor")).toBe(0);
  });
});

describe("run: help", () => {
  it("lists tools by command name with their first sentence", async () => {
    const t = setup();
    expect(await t.exec("--help")).toBe(0);
    expect(t.stdout()).toMatch(/list-apps\s+List all apps in the organization\.\n/);
    expect(t.stdout()).toMatch(/set-env-vars\s+Set the environment variables for an app\./);
    expect(t.stdout()).toContain("login <url>");
  });

  it("shows a command's flags with required ones marked", async () => {
    const t = setup();
    expect(await t.exec("set-env-vars", "--help")).toBe(0);
    expect(t.stdout()).toContain("Usage: vardo set-env-vars --app-id <string> --content <string>");
    expect(t.stdout()).toMatch(/--app-id <string>\s+The app ID \(required\)/);
    expect(t.stdout()).toContain("@file");
  });

  it("caches tools/list so help doesn't refetch", async () => {
    const t = setup();
    await t.exec("--help");
    await t.exec("list-apps", "--help");
    await t.exec("help", "doctor");
    expect(t.calls.filter((c) => c.method === "tools/list")).toHaveLength(1);
  });

  it("still helps when logged out", async () => {
    const t = setup({ loggedIn: false });
    expect(await t.exec()).toBe(0);
    expect(t.stdout()).toContain("Log in to see the commands");
  });
});

describe("run: instances", () => {
  it("logs in from stdin, saves 0600 and verifies with tools/list", async () => {
    const t = setup({ loggedIn: false, stdin: "tok-new\n" });
    expect(await t.exec("login", "https://other.example.com/")).toBe(0);
    const path = join(t.env.XDG_CONFIG_HOME, "vardo", "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      default: "other.example.com",
      instances: { "other.example.com": { url: "https://other.example.com", token: "tok-new" } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(t.calls).toEqual([{ method: "tools/list", params: {} }]);
    expect(t.stdout()).toContain("Logged in to other.example.com (default).");
  });

  it("keeps the default on a second login and switches with use", async () => {
    const t = setup({ stdin: "tok2" });
    await t.exec("login", "http://10.0.0.19:3000", "--name", "home");
    await t.exec("instances");
    expect(t.stdout()).toContain("* vardo.example.com");
    expect(t.stdout()).toContain("  home");
    expect(await t.exec("use", "home")).toBe(0);
    await t.exec("--use", "vardo.example.com", "doctor");
    expect(await t.exec("logout", "home")).toBe(0);
    const config = JSON.parse(readFileSync(join(t.env.XDG_CONFIG_HOME, "vardo", "config.json"), "utf8"));
    expect(config.default).toBe("vardo.example.com");
    expect(Object.keys(config.instances)).toEqual(["vardo.example.com"]);
  });

  it("never prints tokens", async () => {
    const t = setup();
    await t.exec("instances", "--json");
    expect(t.stdout()).not.toContain("tok");
    expect(JSON.parse(t.stdout())).toEqual([{ name: "vardo.example.com", url: "https://vardo.example.com", default: true }]);
  });

  it("refuses an empty token", async () => {
    const t = setup({ loggedIn: false, stdin: "\n" });
    expect(await t.exec("login", "vardo.example.com")).toBe(2);
    expect(t.stderr()).toBe("No token given.\n");
  });
});

describe("result helpers", () => {
  it("renders non-text content as placeholders", () => {
    expect(resultText({ content: [{ type: "image", mimeType: "image/png" }] })).toBe("[image image/png]");
  });

  it("falls back to the raw result for --json", () => {
    const result = { content: [{ type: "text", text: "plain" }] };
    expect(resultJson(result)).toBe(result);
  });

  it("unwraps error messages", () => {
    expect(errorText({ content: [{ type: "text", text: "boom" }], isError: true })).toBe("boom");
    expect(errorText({ content: [], isError: true })).toBe("The tool failed.");
  });
});
