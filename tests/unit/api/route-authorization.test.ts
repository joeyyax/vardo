import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Every org-scoped route must establish who is asking before it answers.
//
// This is a guard against drift, not a proof of correctness — it checks that a
// check exists, not that it guards the right thing. A new route under
// /organizations that forgets one fails here rather than in production.
// ---------------------------------------------------------------------------

const ROUTES_DIR = join(process.cwd(), "app/api/v1/organizations");

const ACCESS_CHECKS = [
  "verifyOrgAccess",
  "verifyAppAccess",
  "verifyProjectAccess",
  "verifyAccess",
  "requireAdmin",
];

/**
 * Routes that legitimately have no orgId to check, with the reason each is
 * safe. Adding to this list should take an argument, not a shrug.
 */
const EXEMPT: Record<string, string> = {
  "route.ts": "lists the caller's own organizations — scoped by session, not by a path param",
  "switch/route.ts": "verifies membership inline before setting the active-org cookie",
};

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

describe("org-scoped API routes", () => {
  const files = routeFiles(ROUTES_DIR);

  it("finds routes to check, so a bad path cannot make this vacuously pass", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((f) => [relative(ROUTES_DIR, f), f]))(
    "%s establishes access",
    (rel, full) => {
      if (rel in EXEMPT) {
        expect(EXEMPT[rel]).toBeTruthy();
        return;
      }
      const source = readFileSync(full, "utf8");
      const hasCheck = ACCESS_CHECKS.some((fn) => source.includes(fn));
      expect(hasCheck, `${rel} calls none of: ${ACCESS_CHECKS.join(", ")}`).toBe(true);
    },
  );

  it("keeps the exemption list from outliving the routes it describes", () => {
    const present = new Set(files.map((f) => relative(ROUTES_DIR, f)));
    for (const rel of Object.keys(EXEMPT)) {
      expect(present.has(rel), `${rel} is exempted but no longer exists`).toBe(true);
    }
  });
});
