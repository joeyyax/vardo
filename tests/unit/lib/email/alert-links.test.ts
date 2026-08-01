import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isAppTab } from "@/lib/ui/app-tabs";

const TEMPLATE_DIR = join(process.cwd(), "lib/email/templates");
const templates = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".tsx"));

function source(file: string) {
  return readFileSync(join(TEMPLATE_DIR, file), "utf8");
}

describe("alert email links", () => {
  it("finds templates to check", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  // The app route reads path segments only. A ?tab= link silently lands on the
  // default tab.
  it.each(templates)("%s does not link with ?tab=", (file) => {
    expect(source(file)).not.toContain("?tab=");
  });

  it.each(templates)("%s only appends real app tabs to dashboardUrl", (file) => {
    const segments = [...source(file).matchAll(/\$\{dashboardUrl\}\/([\w-]+)/g)].map((m) => m[1]);
    for (const segment of segments) {
      expect(isAppTab(segment), `${file} links to /${segment}`).toBe(true);
    }
  });

  // dashboardUrl is built from an app id, which /projects rejects.
  it.each(templates)("%s example url points at the app route", (file) => {
    const example = source(file).match(/dashboardUrl: "(https:\/\/[^"]+)"/)?.[1];
    if (!example) return;
    expect(example).not.toContain("/projects/");
  });
});
