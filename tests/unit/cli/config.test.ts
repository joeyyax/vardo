import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { configPath, loadConfig, normalizeUrl, resolveTarget, saveConfig, type Config } from "@/packages/cli/src/config";

const fresh = () => mkdtempSync(join(tmpdir(), "vardo-cli-config-"));

describe("configPath", () => {
  it("follows XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/vardo/config.json");
    expect(configPath({})).toMatch(/\.config\/vardo\/config\.json$/);
  });
});

describe("saveConfig and loadConfig", () => {
  it("writes the file 0600 in a 0700 directory and reads it back", () => {
    const path = join(fresh(), "vardo", "config.json");
    const config: Config = { default: "a", instances: { a: { url: "https://a", token: "t" } } };
    saveConfig(path, config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(loadConfig(path)).toEqual(config);
  });

  it("tightens an existing file's mode on save", () => {
    const dir = join(fresh(), "vardo");
    mkdirSync(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    saveConfig(path, { instances: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a missing file as empty", () => {
    expect(loadConfig(join(fresh(), "none.json"))).toEqual({ instances: {} });
  });

  it("rejects invalid JSON", () => {
    const path = join(fresh(), "config.json");
    writeFileSync(path, "{");
    expect(() => loadConfig(path)).toThrow("isn't valid JSON");
  });
});

describe("normalizeUrl", () => {
  it("adds https and trims the MCP path and slashes", () => {
    expect(normalizeUrl("vardo.example.com")).toBe("https://vardo.example.com");
    expect(normalizeUrl("https://vardo.example.com/")).toBe("https://vardo.example.com");
    expect(normalizeUrl("https://vardo.example.com/api/mcp")).toBe("https://vardo.example.com");
    expect(normalizeUrl("http://10.0.0.19:3000")).toBe("http://10.0.0.19:3000");
  });

  it("rejects other schemes", () => {
    expect(() => normalizeUrl("ftp://x")).toThrow("isn't an http or https URL");
  });
});

describe("resolveTarget", () => {
  const config: Config = {
    default: "a.example.com",
    instances: {
      "a.example.com": { url: "https://a.example.com", token: "ta" },
      home: { url: "http://10.0.0.19:3000", token: "th" },
    },
  };

  it("uses the default", () => {
    expect(resolveTarget(config, {})).toEqual({ name: "a.example.com", url: "https://a.example.com", token: "ta" });
  });

  it("uses --use over env and default", () => {
    expect(resolveTarget(config, { VARDO_URL: "https://b.example.com", VARDO_TOKEN: "tb" }, "home").token).toBe("th");
    expect(() => resolveTarget(config, {}, "nope")).toThrow("No saved instance named nope.");
  });

  it("lets VARDO_URL and VARDO_TOKEN override the config", () => {
    expect(resolveTarget(config, { VARDO_URL: "b.example.com", VARDO_TOKEN: "tb" })).toEqual({
      name: "b.example.com",
      url: "https://b.example.com",
      token: "tb",
    });
    expect(resolveTarget(config, { VARDO_URL: "http://10.0.0.19:3000" })).toMatchObject({ name: "home", token: "th" });
    expect(resolveTarget(config, { VARDO_TOKEN: "override" })).toMatchObject({ url: "https://a.example.com", token: "override" });
  });

  it("explains what's missing", () => {
    expect(() => resolveTarget({ instances: {} }, {})).toThrow("Not logged in.");
    expect(() => resolveTarget({ instances: {} }, { VARDO_URL: "https://c" })).toThrow("Set VARDO_TOKEN");
    expect(() => resolveTarget({ instances: {} }, { VARDO_TOKEN: "t" })).toThrow("VARDO_URL isn't");
  });
});
