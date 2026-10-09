import { scanEnv } from "./dotenv";

const MASKED = "••••••••";

function maskLine(line: string): string {
  if (line.startsWith("#") || !line.includes("=")) return line;
  return `${line.slice(0, line.indexOf("="))}=${MASKED}`;
}

/** Env content with every value hidden; a multi-line value collapses to one line. */
export function maskEnvContent(content: string): string {
  return scanEnv(content, "loose")
    .map((segment) => (segment.kind === "var" && segment.multiline ? `${segment.key}=${MASKED}` : maskLine(segment.raw)))
    .join("\n");
}
