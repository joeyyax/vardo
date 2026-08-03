import { describe, it, expect } from "vitest";
import { loadTemplates } from "@/lib/templates/load";
import { createAppSchema } from "@/lib/api/create-app-schema";
import {
  buildCreateAppBody,
  missingRequiredEnvKeys,
  templateEnvContent,
  templateFormState,
} from "@/lib/templates/create-payload";

const templates = await loadTemplates();

describe("shipped templates", () => {
  it("loads every yaml in templates/", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(templates.map((t) => [t.name, t] as const))(
    "%s produces a create payload the API accepts",
    (_name, template) => {
      const form = templateFormState(template, "test-app-spicy-mango");
      const body = buildCreateAppBody({ ...form, projectId: "project-1" });

      const result = createAppSchema.safeParse(body);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  );

  it.each(templates.map((t) => [t.name, t] as const))(
    "%s has something to deploy from",
    (_name, template) => {
      const form = templateFormState(template, "test-app-spicy-mango");
      const body = buildCreateAppBody({ ...form, projectId: "project-1" });

      expect(
        Boolean(body.imageName) || Boolean(body.gitUrl) || Boolean(body.composeContent)
      ).toBe(true);
    }
  );

  it.each(templates.map((t) => [t.name, t] as const))(
    "%s fills in every required env var",
    (_name, template) => {
      expect(missingRequiredEnvKeys(template, templateEnvContent(template))).toEqual([]);
    }
  );

  it("records the template name for provenance", () => {
    const template = templates[0];
    const form = templateFormState(template, "test-app-spicy-mango");
    const body = buildCreateAppBody({ ...form, projectId: "project-1" });
    expect(body.templateName).toBe(template.name);
  });
});

describe("env autofill", () => {
  it("resolves a prefixed domain var", () => {
    const content = templateEnvContent({
      name: "glitchtip",
      displayName: "GlitchTip",
      defaultEnvVars: [
        { key: "GLITCHTIP_DOMAIN", description: "Public URL", required: true },
      ],
    } as Parameters<typeof templateEnvContent>[0]);

    expect(content).toContain("GLITCHTIP_DOMAIN=${project.domain}");
  });

  it("leaves service connection strings alone", () => {
    const content = templateEnvContent({
      name: "app",
      displayName: "App",
      defaultEnvVars: [
        { key: "DATABASE_URL", description: "", required: false },
        { key: "WORDPRESS_DB_HOST", description: "", required: false },
      ],
    } as Parameters<typeof templateEnvContent>[0]);

    expect(content).toContain("DATABASE_URL=\n");
    expect(content).not.toContain("WORDPRESS_DB_HOST=${project.domain}");
  });
});
