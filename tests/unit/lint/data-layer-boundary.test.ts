import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

// Lints fixtures through the repo's own config, as if they lived at the given app paths.

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.join(__dirname, "fixtures");
const RULE = "vardo/data-layer-boundary";

const eslint = new ESLint({ cwd: ROOT });

async function boundaryErrors(fixture: string, at: string) {
  const code = fs.readFileSync(path.join(FIXTURES, fixture), "utf8");
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, at) });
  return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe("data-layer boundary lint rule", { timeout: 60_000 }, () => {
  it("fails a page that imports @/lib/db", async () => {
    const errors = await boundaryErrors("page-imports-db.tsx.fixture", "app/(authenticated)/fixture/page.tsx");
    expect(errors).toEqual([expect.stringContaining("A page can't import @/lib/db")]);
  });

  it("passes a page that reads through app-services", async () => {
    expect(await boundaryErrors("page-imports-service.tsx.fixture", "app/(authenticated)/fixture/page.tsx")).toEqual([]);
  });

  it("fails a layout that reaches lib/docker by a relative path", async () => {
    const errors = await boundaryErrors("layout-imports-docker.tsx.fixture", "app/(authenticated)/fixture/layout.tsx");
    expect(errors).toEqual([expect.stringContaining("A layout can't import @/lib/docker/client")]);
  });

  it("checks client components wherever they live, allowing types and the pure helpers", async () => {
    const errors = await boundaryErrors("client-imports.tsx.fixture", "components/fixture-panel.tsx");
    expect(errors).toEqual([
      expect.stringContaining("A client component can't import @/lib/db/schema"),
      expect.stringContaining("Client components can't import @/lib/app-services/apps"),
    ]);
  });

  it("leaves API routes and server modules alone", async () => {
    expect(await boundaryErrors("page-imports-db.tsx.fixture", "app/api/v1/fixture/route.tsx")).toEqual([]);
    expect(await boundaryErrors("page-imports-db.tsx.fixture", "components/fixture-server.tsx")).toEqual([]);
  });
});
