import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Mesh peers are instance-wide. Anything under app/ that reads them is either
// instance-admin only, peer-authenticated or scoped by role (#875).

const APP = path.resolve(__dirname, "../../../../app");

const ALLOWED: Record<string, string> = {
  "api/v1/admin/mesh": "requireAppAdmin",
  "api/v1/mesh": "requireMeshPeer",
  "api/v1/mesh/join/route.ts": "redeemInvite",
  "api/setup/progress/route.ts": "requireAdminAuth",
  "(authenticated)/projects/[...slug]/page.tsx": "isAppAdmin",
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const readers = files(APP)
  .map((f) => ({ file: path.relative(APP, f), src: fs.readFileSync(f, "utf8") }))
  .filter(({ src }) => /\bmeshPeers\b/.test(src) && /from "@\/lib\/db"/.test(src));

describe("mesh peer readers", () => {
  it("finds the readers", () => {
    expect(readers.length).toBeGreaterThan(3);
  });

  it.each(readers)("$file is gated", ({ file, src }) => {
    const key = Object.keys(ALLOWED)
      .filter((k) => file === k || file.startsWith(`${k}/`))
      .sort((a, b) => b.length - a.length)[0];
    expect(key, `${file} reads mesh peers`).toBeDefined();
    expect(src).toContain(ALLOWED[key!]);
  });

  it("keeps peers out of org routes", () => {
    expect(readers.filter(({ file }) => file.startsWith("api/v1/organizations/"))).toEqual([]);
  });

  it.each(readers.filter(({ file }) => file.startsWith("api/v1/admin/mesh/")))(
    "$file checks instance admin in every handler",
    ({ src }) => {
      const handlers = src.match(/async function (GET|POST|PUT|PATCH|DELETE|handle\w+)\(/g) ?? [];
      const gates = src.match(/await requireAppAdmin\(\)/g) ?? [];
      expect(gates.length).toBeGreaterThanOrEqual(handlers.length);
    },
  );
});
