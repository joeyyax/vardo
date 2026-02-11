import * as esbuild from "esbuild";
import { copyFileSync } from "fs";

esbuild
  .build({
    entryPoints: ["widget/core.ts"],
    bundle: true,
    format: "iife",
    globalName: "ScopeWidget",
    outfile: "public/widget/scope.js",
    target: "es2020",
    minify: true,
    sourcemap: false,
  })
  .then(() => {
    console.log("Widget built → public/widget/scope.js");

    // Backward compat: copy to old filename for existing script tags
    copyFileSync("public/widget/scope.js", "public/widget/bug-report.js");
    console.log("Copied → public/widget/bug-report.js (backward compat)");
  })
  .catch((err: unknown) => {
    console.error("Build failed:", err);
    process.exit(1);
  });
