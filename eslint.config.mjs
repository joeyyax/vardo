import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vardoRules from "./scripts/eslint/data-layer-boundary.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    ignores: ["lib/messenger/toast.ts", "components/ui/sonner.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "sonner",
          importNames: ["toast"],
          message: "Use `import { toast } from \"@/lib/messenger\"` instead.",
        }],
      }],
    },
  },
  {
    files: ["lib/uptime/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@/*", "!@/lib/uptime/core", "!@/lib/uptime/core/*", "../*"],
          message: "The uptime core imports only node built-ins, npm packages and itself.",
        }],
      }],
    },
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    plugins: { vardo: vardoRules },
    rules: {
      "vardo/data-layer-boundary": "error",
    },
  },
  {
    rules: {
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // Worker and CLI bundles:
    "dist/**",
    "packages/*/dist/**",
    "next-env.d.ts",
    // Generated test reports:
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    // Ignore worktrees and host project copies:
    ".claude/worktrees/**",
    ".worktrees/**",
    ".host/**",
  ]),
]);

export default eslintConfig;
