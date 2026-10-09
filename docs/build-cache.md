# Build cache baseline

Measured 2026-10-08 on one Apple Silicon Mac (OrbStack, 14 CPUs), Railpack 0.35.0 and Nixpacks 1.41.0 (the versions in the Dockerfile) against a throwaway `moby/buildkit:v0.34.0` with the production gc policy. Commands and flags match `buildFromRepo` in `lib/docker/deploy-steps/prepare-repo.ts`. Seconds, mean of two runs.

| App | Run | Railpack | Nixpacks |
| --- | --- | --- | --- |
| `heroku/node-js-getting-started` | Cold | 53 | 51 |
| | Warm, same commit | 2.0 | 1.0 |
| | One-line source change | 4.2 | 2.7 |
| | Dependency added | 10.8 | 2.6 |
| | Warm after BuildKit restart | 1.9 | 0.9 |
| | Cache size | 2.6 GB | 1.1 GB |
| `vercel/next.js` `examples/hello-world` (Next 15.5.27, pinned) | Cold | 55 | 52 |
| | Warm, same commit | 2.3 | 1.1 |
| | One-line source change | 14.8 | 15.5 |
| | Dependency added | 27.4 | 16.8 |
| | Warm after BuildKit restart | 3.5 | 0.9 |
| | Cache size | 4.2 GB | 2.0 GB |

Neither repo has a Dockerfile, so Dockerfile builds weren't measured; they use the same BuildKit and layer cache.

Caveats:

- Cold runs include pulling base images; the first run of each pair was slower (node Railpack 67s, then 40s).
- Railpack times include loading the image into Docker. Nixpacks ran on a second throwaway buildx builder (`BUILDX_BUILDER`) so its cache could start empty, and that run doesn't load the image, so its times are about a second low.
- Two runs per cell is a baseline, not a benchmark.

## What it means

- **Both caches work.** An unchanged commit rebuilds in 1 to 3 seconds. The cache survives a BuildKit restart on its volume (Railpack 1.9s and 3.5s after restart); Nixpacks uses Docker's own builder cache, which survives dockerd restarts the same way.
- **Source changes cost the same on both for Next** (about 15s, the `next build` itself). Railpack mounts `.next/cache` and `node_modules/.cache`; so does Nixpacks.
- **Nixpacks reinstalls on every source change.** Its install phase runs `COPY . /app` before `npm ci`, so any file change reruns the install (kept fast by its npm cache mount). Railpack copies the manifest first, so a source change skips the install entirely.
- **Dependency changes:** Nixpacks was faster in both repos (2.6s vs 10.8s, 16.8s vs 27.4s). Not investigated further.
- **Railpack's cache is about twice Nixpacks'** (toolchain layers from mise, apt, the cache mounts).
- **Auto-detect preference:** keep Railpack first when BuildKit is reachable. The measured speed is a wash, and Railpack's structure is better for large dependency trees where a source change shouldn't reinstall. Nixpacks stays the right fallback; it's no worse on rebuild latency for these two apps.

## Cache size ceiling

BuildKit is capped by the gc policy in `docker-compose.yml` (`VARDO_BUILDKIT_CACHE_MAX`, default 10 GiB). One Next app plus one Node app fills about 6 GB, so the default holds a handful of apps before LRU eviction starts.

Nixpacks builds land in the Docker daemon's own builder cache. That one is already bounded: `post-deploy.ts` prunes it to `BUILD_CACHE_MAX_BYTES` after each deploy. No separate Nixpacks ceiling is needed.

## Change: per-app Railpack cache key

Railpack names its cache mounts `next`, `node-modules` and `npm-install` with no app prefix, so every app on the daemon shared them. A build could read another app's `.next/cache`: a marker file written by one app's build was readable from a second app's build. Vardo now passes `--cache-key <appId>`, which scopes the mounts per app. Layer cache is unaffected: a fresh key on identical content rebuilt in 1.1s, and a source change took 10.9s with a key vs 9.8s without.

The cost is that a brand new app starts with an empty npm cache mount instead of borrowing another app's.

## Follow-ups

- Find why Railpack's dependency rebuild is slower than Nixpacks' (mise or install layer).
- Report BuildKit cache size in the console so the ceiling is visible before it evicts.

## Build plan and overrides

Before a Railpack or Nixpacks build, Vardo captures the engine's plan with the same env and overrides as the build:

- Railpack: `railpack info --format json [--build-cmd X] [--start-cmd Y] [--env K=V] <dir>`. `railpack plan` prints only the plan; `info` adds detected providers, resolved versions and detection logs. Neither needs BuildKit.
- Nixpacks: `nixpacks plan <dir> --format json [--build-cmd X] [--start-cmd Y] [--env K=V]`. It doesn't say why a provider matched, so Vardo lists the repo files that point to it.

The plan is stored on `deployment.build_plan` with app env values masked, summarized in the deploy log and shown on the deployment.

App settings carry a build command, start command and builder (Railpack or Nixpacks). Both engines take `--build-cmd` and `--start-cmd` on `build` and on the plan command. The builder applies when a compose-type app's repo has no compose file or Dockerfile. Blank means auto.
