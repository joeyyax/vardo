// Bundles worker/index.ts to dist/worker.mjs. Packages stay external: the runner image has prod node_modules.

import { build } from "esbuild";
import { writeFileSync } from "fs";

/** Imports the worker must never reach: Next's runtime only exists inside `next start`. */
export const FORBIDDEN = /^next(\/|$)/;

// The worker is a server process; `server-only` throws outside Next's react-server condition.
const serverOnly = {
  name: "server-only",
  setup(b) {
    b.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
  },
};

/** Builds the bundle and returns esbuild's metafile. */
export async function buildWorker({ outfile = "dist/worker.mjs", write = true } = {}) {
  const result = await build({
    entryPoints: ["worker/index.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    tsconfig: "tsconfig.json",
    sourcemap: "linked",
    metafile: true,
    write,
    logLevel: "warning",
    plugins: [serverOnly],
    // Next inlines this at build; the runner image doesn't set it.
    define: { "process.env.NEXT_PUBLIC_GIT_SHA": JSON.stringify(process.env.NEXT_PUBLIC_GIT_SHA ?? "") },
    // ESM output has no require; a few dependencies still call it.
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  });
  return result.metafile;
}

/** Every forbidden import in a metafile, as "importer -> specifier". */
export function forbiddenImports(metafile) {
  const found = [];
  for (const [file, info] of Object.entries(metafile.inputs)) {
    for (const imp of info.imports) if (FORBIDDEN.test(imp.path)) found.push(`${file} -> ${imp.path}`);
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const metafile = await buildWorker();
  const bad = forbiddenImports(metafile);
  if (bad.length > 0) {
    console.error(`[build-worker] The worker reaches Next-only modules:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  if (process.env.WORKER_METAFILE) writeFileSync(process.env.WORKER_METAFILE, JSON.stringify(metafile));
  console.log(`[build-worker] dist/worker.mjs from ${Object.keys(metafile.inputs).length} modules`);
}
