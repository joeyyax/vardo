// Plain sentences for known deploy errors. Never carries stderr, hosts, paths or env.

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

type Rule = [RegExp, (m: RegExpMatchArray) => string];

// First match wins; the message may carry stderr after the matched prefix.
const RULES: Rule[] = [
  [/The build ran out of memory/, () => "The build ran out of memory."],
  [/^(?:nixpacks|railpack|docker) timed out after (\d+)s/, (m) => `The build took longer than the ${minutes(Number(m[1]))} minute limit.`],
  [/^(?:nixpacks|railpack|docker) failed \(exit (\d+)\)/, (m) => `Build failed (exit ${m[1]}).`],
  [/^(?:nixpacks|railpack|docker) failed \(exit /, () => "Build failed."],
  [/^Deployment timed out after (\d+) minutes/, (m) => `The deploy took longer than the ${m[1]} minute limit.`],
  [/^\S+ slot did not become healthy: .* crashed \(/, () => "The new version crashed before passing its health check."],
  [/^\S+ slot did not become healthy: .* healthcheck reports unhealthy/, () => "The new version failed its health check."],
  [/^\S+ is still starting after \d+s/, () => "The new version was still starting when its health check timed out."],
  [/^\S+ slot did not become ready within \d+s/, () => "The new version didn't become ready in time."],
  [/^Pre-build\/pre-pull for \S+ failed .*Command failed: docker compose .* pull\b/, () => "Couldn't pull the image."],
  [/^Pre-build\/pre-pull for \S+ failed .*Command failed: docker compose .* build\b/, () => "The image build failed."],
  [/^Pre-build\/pre-pull for \S+ failed/, () => "Couldn't build or pull the image."],
  [/^docker compose up \(\S+\) failed/, () => "The containers failed to start."],
  [/^Shared services failed to start/, () => "Shared services failed to start."],
  [/^Couldn't clone /, () => "Couldn't clone the repository."],
  [/^Command failed: git\b/, () => "Couldn't fetch the repository."],
  [/^Command failed: /, () => "A command failed during the deploy."],
  [/^Deployment was stuck in the queue for (\d+) minutes and was cancelled$/, (m) => `The deploy waited in the queue longer than ${m[1]} minutes and was cancelled.`],
  [/^Deployment never started\b.* and was cancelled$/, () => "The deploy was cancelled before it started."],
  [/^Deployment aborted$/, () => "The deploy was stopped."],
  [/^Cancelled$/, () => "The deploy was cancelled."],
  [/^Rolled back after the deploy$/, () => "The new version stopped soon after going live."],
];

/** A readable sentence for a known deploy error, else null. */
export function knownFailure(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  for (const [re, say] of RULES) {
    const m = flat.match(re);
    if (m) return say(m);
  }
  return null;
}
