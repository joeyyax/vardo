import { describe, it, expect } from "vitest";
import { commandName, kebab, shapeOf, toolFlags } from "@/packages/cli/src/schema";

describe("kebab", () => {
  it("converts camelCase and snake_case", () => {
    expect(kebab("appId")).toBe("app-id");
    expect(kebab("includeEnvVars")).toBe("include-env-vars");
    expect(kebab("pr_url")).toBe("pr-url");
    expect(kebab("instance")).toBe("instance");
  });
});

describe("commandName", () => {
  it("drops the vardo_ prefix", () => {
    expect(commandName("vardo_deploy_app")).toBe("deploy-app");
    expect(commandName("vardo_doctor")).toBe("doctor");
  });
});

describe("shapeOf", () => {
  it("reads plain types", () => {
    expect(shapeOf({ type: "string" })).toEqual({ kind: "string", item: undefined, nullable: false });
    expect(shapeOf({ type: "integer" }).kind).toBe("integer");
    expect(shapeOf({ type: "boolean" }).kind).toBe("boolean");
    expect(shapeOf({ type: "object" }).kind).toBe("json");
    expect(shapeOf({}).kind).toBe("json");
  });

  it("reads enums as choices", () => {
    expect(shapeOf({ type: "string", enum: ["force", "no-cache"] })).toMatchObject({ kind: "string", choices: ["force", "no-cache"] });
  });

  it("reads nullable type lists and anyOf", () => {
    expect(shapeOf({ type: ["string", "null"] })).toMatchObject({ kind: "string", nullable: true });
    expect(shapeOf({ anyOf: [{ type: "string", format: "uri" } as never, { type: "null" }] })).toMatchObject({ kind: "string", nullable: true });
    expect(shapeOf({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] })).toMatchObject({
      kind: "array",
      item: "string",
      nullable: true,
    });
  });

  it("reads numeric consts as number choices", () => {
    expect(shapeOf({ anyOf: [{ type: "number", const: 301 }, { type: "number", const: 302 }] })).toMatchObject({
      kind: "number",
      choices: [301, 302],
    });
  });

  it("reads array item kinds", () => {
    expect(shapeOf({ type: "array", items: { type: "object" } })).toMatchObject({ kind: "array", item: "json" });
    expect(shapeOf({ type: "array" })).toMatchObject({ kind: "array", item: "string" });
  });
});

describe("toolFlags", () => {
  it("maps each property to a flag, required first", () => {
    const flags = toolFlags({
      name: "vardo_set_env_vars",
      inputSchema: {
        type: "object",
        properties: {
          instance: { type: "string", description: "Linked instance" },
          appId: { type: "string" },
          content: { type: "string" },
          limit: { type: "integer", default: 50 },
        },
        required: ["appId", "content"],
      },
    });
    expect(flags.map((f) => [f.name, f.prop, f.required])).toEqual([
      ["app-id", "appId", true],
      ["content", "content", true],
      ["instance", "instance", false],
      ["limit", "limit", false],
    ]);
    expect(flags[3].default).toBe(50);
  });

  it("handles a tool without a schema", () => {
    expect(toolFlags({ name: "vardo_doctor" })).toEqual([]);
  });
});
