import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    ignores: ["lib/notify/toast.ts", "components/ui/sonner.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "sonner",
          importNames: ["toast"],
          message: "Use `import { notify } from \"@/lib/notify\"` and `notify.toast.*` instead.",
        }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
