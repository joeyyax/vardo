// Bundles src/main.ts to dist/vardo.mjs, the package's bin.

import { build } from "esbuild";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outfile = fileURLToPath(new URL("dist/vardo.mjs", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log("[cli] dist/vardo.mjs");
