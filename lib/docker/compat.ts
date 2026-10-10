/** Detects common build issues from error output and applies known env fixes. */

type CompatFix = {
  name: string;
  description: string;
  detect: (error: string) => boolean;
  envVars: Record<string, string>;
};

const KNOWN_FIXES: CompatFix[] = [
  {
    name: "openssl-legacy",
    description: "Node.js 17+ OpenSSL 3.0 compatibility for older webpack/Next.js",
    detect: (error) =>
      error.includes("ERR_OSSL_EVP_UNSUPPORTED") ||
      error.includes("digital envelope routines::unsupported") ||
      error.includes("error:0308010C"),
    envVars: { NODE_OPTIONS: "--openssl-legacy-provider" },
  },
  {
    name: "python-setuptools",
    description: "Python setuptools missing for native module builds",
    detect: (error) =>
      error.includes("ModuleNotFoundError: No module named 'setuptools'") ||
      error.includes("No module named 'distutils'"),
    envVars: { NIXPACKS_APT_PKGS: "python3-setuptools python3-distutils" },
  },
  {
    name: "sharp-linux",
    description: "Sharp image library platform mismatch",
    detect: (error) =>
      error.includes("Could not load the \"sharp\" module") ||
      error.includes("sharp: Installation error"),
    envVars: { npm_config_platform: "linux", npm_config_arch: "x64" },
  },
  {
    name: "next-telemetry",
    description: "Disable Next.js telemetry in CI builds",
    detect: (error) =>
      error.includes("NEXT_TELEMETRY_DISABLED"),
    envVars: { NEXT_TELEMETRY_DISABLED: "1" },
  },
  {
    name: "memory-limit",
    description: "Increase Node.js memory for large builds",
    detect: (error) =>
      error.includes("FATAL ERROR: Reached heap limit") ||
      error.includes("JavaScript heap out of memory") ||
      error.includes("ENOMEM"),
    envVars: { NODE_OPTIONS: "--max-old-space-size=4096" },
  },
  {
    name: "prisma-generate",
    description: "Prisma client not generated before build",
    detect: (error) =>
      error.includes("@prisma/client did not initialize") ||
      error.includes("prisma generate"),
    envVars: { NIXPACKS_BUILD_CMD: "npx prisma generate && npm run build" },
  },
];

/** Fixes that match build error output. */
export function detectCompatIssues(errorOutput: string): CompatFix[] {
  return KNOWN_FIXES.filter((fix) => fix.detect(errorOutput));
}

/** Merge fix env vars into existing ones, appending to NODE_OPTIONS and NIXPACKS_APT_PKGS. */
export function applyCompatFixes(
  envVars: Record<string, string>,
  fixes: CompatFix[]
): Record<string, string> {
  const result = { ...envVars };

  for (const fix of fixes) {
    for (const [key, value] of Object.entries(fix.envVars)) {
      if (key === "NODE_OPTIONS" && result[key]) {
        result[key] = `${result[key]} ${value}`;
      } else if (key === "NIXPACKS_APT_PKGS" && result[key]) {
        result[key] = `${result[key]} ${value}`;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/** Preventive fixes detected from package.json before the first build. */
export async function detectPreventiveFixes(
  repoPath: string,
  repoDir: string = repoPath,
): Promise<CompatFix[]> {
  const fixes: CompatFix[] = [];
  const { readFile } = await import("fs/promises");
  const { repoFilePath } = await import("./compose-root");

  try {
    const pkgJson = JSON.parse(
      await readFile(repoFilePath(repoDir, repoPath, "package.json"), "utf-8")
    );
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

    // Next.js < 13 needs the OpenSSL legacy provider.
    const nextVersion = deps?.next;
    if (nextVersion) {
      const major = parseInt(nextVersion.replace(/[^0-9]/g, "").slice(0, 2));
      if (major && major < 13) {
        fixes.push(KNOWN_FIXES.find((f) => f.name === "openssl-legacy")!);
      }
    }

    // So does webpack < 5.
    const webpackVersion = deps?.webpack;
    if (webpackVersion) {
      const major = parseInt(webpackVersion.replace(/[^0-9]/g, "").charAt(0));
      if (major && major < 5) {
        fixes.push(KNOWN_FIXES.find((f) => f.name === "openssl-legacy")!);
      }
    }

    if (deps?.next) {
      fixes.push(KNOWN_FIXES.find((f) => f.name === "next-telemetry")!);
    }

    if (deps?.sharp) {
      fixes.push(KNOWN_FIXES.find((f) => f.name === "sharp-linux")!);
    }

    if (deps?.["@prisma/client"]) {
      fixes.push(KNOWN_FIXES.find((f) => f.name === "prisma-generate")!);
    }
  } catch {
    // Not a Node project.
  }

  return fixes.filter(Boolean);
}
