// Lists dangling anonymous volumes that look like leaked drill databases. Read-only: removes nothing.
// Usage: tsx scripts/leaked-volumes.ts [--since 2026-10-09] [--json]

import { execFileSync } from "node:child_process";
import { leakCandidates, PROBE_MARKERS, type VolumeFacts } from "../lib/backups/leaked-volumes";

const args = process.argv.slice(2);
const sinceArg = args.indexOf("--since");
const since = new Date(sinceArg >= 0 ? args[sinceArg + 1] : "2026-10-09");
if (Number.isNaN(since.getTime())) throw new Error("--since needs a date like 2026-10-09");
const asJson = args.includes("--json");

const docker = (argv: string[]) => execFileSync("docker", argv, { encoding: "utf8", timeout: 120_000 });

const names = docker(["volume", "ls", "-q", "--filter", "dangling=true"]).split("\n").filter(Boolean);

const facts: VolumeFacts[] = names.map((name) => {
  const meta = JSON.parse(docker(["volume", "inspect", name]))[0] as { CreatedAt?: string; Labels?: Record<string, string> | null };
  const find = PROBE_MARKERS.flatMap((m, i) => [...(i ? ["-o"] : []), "-name", m]).join(" ");
  let markers = "";
  let sizeKb: number | null = null;
  try {
    // Read-only mount of a volume nothing else uses; alpine declares no VOLUME, so the probe leaves nothing behind.
    const out = docker([
      "run", "--rm", "--pull", "never", "--log-driver", "none", "--network", "none",
      "-v", `${name}:/v:ro`, "alpine", "sh", "-c",
      `find /v -maxdepth 3 \\( ${find} \\); echo "SIZE_KB=$(du -sk /v | cut -f1)"`,
    ]);
    markers = out.replace(/^SIZE_KB=.*$/m, "");
    const size = out.match(/^SIZE_KB=(\d+)$/m);
    sizeKb = size ? Number(size[1]) : null;
  } catch {
    // Unreadable volumes stay off the list.
  }
  return { name, labels: meta.Labels ?? {}, createdAt: meta.CreatedAt ?? null, markers, sizeKb };
});

const found = leakCandidates(facts, { since });

if (asJson) {
  console.log(JSON.stringify(found, null, 2));
} else {
  for (const c of found) {
    const mb = c.sizeKb == null ? "?" : (c.sizeKb / 1024).toFixed(0);
    console.log(`${c.name}\t${c.createdAt ?? "?"}\t${c.kind}\t${mb} MB\t${c.labeled ? "labeled" : "unlabeled"}`);
  }
  const total = found.reduce((n, c) => n + (c.sizeKb ?? 0), 0);
  console.error(`${found.length} candidate(s) of ${names.length} dangling volume(s), ${(total / 1024 / 1024).toFixed(1)} GB. Nothing was removed.`);
  console.error("Review the list. Unlabeled matches are inferred from content and age and could hold a deleted app's data.");
}
