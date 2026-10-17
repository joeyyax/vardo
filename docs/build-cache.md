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

BuildKit is capped by the gc policy in `docker-compose.yml` (`VARDO_BUILDKIT_CACHE_MAX`). install.sh sets it to an eighth of the disk, between 5 and 60 GiB, on install and on every update when it's missing; a value equal to the earlier tenth-of-disk rule is raised to the current one. A self-deploy with no value in `.env` derives the same number for its slot. Without any of these the compose default is 10 GiB. One Next app plus one Node app fills about 6 GB.

Two gc policies run in order:

1. Layers and other records unused for 7 days go first, until the cache is under the ceiling. Cache mounts (`exec.cachemount`: npm, pnpm, `.next/cache`) are left alone.
2. Then anything, least recently used first, keeping 1 GB reserved and 5 GB of disk free.

So a full cache gives up stale layers before a recent app's layers or any package-manager cache.

Admin → Settings → Maintenance reports and prunes both caches; BuildKit's is read with `buildctl du`, since `docker system df` can't see inside its volume (#815).

Nixpacks builds run on BuildKit too (see [Nixpacks on the bounded builder](#nixpacks-on-the-bounded-builder)), so they share its ceiling. Only the fallback, Nixpacks' own build, lands in the Docker daemon's builder cache, which `post-deploy.ts` prunes to `BUILD_CACHE_MAX_BYTES` after each deploy.

## Checkout and build tree

Every environment of an app shares one shallow checkout at `<app>/repo`. Each deploy fetches its branch with an explicit refspec (`+refs/heads/<b>:refs/remotes/origin/<b>`, depth 1), so a preview of another branch no longer fails the reset and re-clones, and production no longer re-clones after it.

A per-app lock (in-process, plus a Redis lease) covers the fetch, the checkout and writing the build tree, so a preview and production can't move the checkout under each other. It's held for seconds, not the build.

Builds read `<app>/<env>/build-source`: the deployed commit's files written by `git read-tree -u` with the environment's own index (`build-source.index`). Only changed files are rewritten, and it has no `.git`, so a fetch, which rewrites `.git/index`, no longer invalidates `COPY . .`. It works the same for Dockerfile, compose, Railpack and Nixpacks builds, and the repo's own `.dockerignore` still applies. Compose bind mounts still resolve through the shared checkout.

Limits:

- A Dockerfile that reads `.git` (`COPY .git`, a `.git` bind mount, or `git rev-parse`, `describe`, `log` and the like in a step) gets the checkout's `.git` copied in, pointed at the deployed commit. Compose services' Dockerfiles are checked too. Those builds rebuild from that `COPY` on every commit, as before.
- Railpack and Nixpacks builds aren't scanned. One whose build runs git (a `next.config` calling `git rev-parse` without a fallback) sets `VARDO_BUILD_INCLUDE_GIT=true` in the app's env.
- The alternative is a build arg: Dockerfile and compose builds get `VARDO_GIT_SHA` (compose only when the file doesn't set it). Declare `ARG VARDO_GIT_SHA` to use it; undeclared, it changes nothing.
- Each environment's build tree is a full copy of the commit's files.

## Image reuse

A Dockerfile, Railpack or Nixpacks build whose inputs match an earlier deploy of the same app skips the build and retags that image. The log says `Reused image from deploy <id>, nothing build-relevant changed`.

The key (`deployment.build_key`, and the `vardo.build.key` label on Dockerfile images) is a SHA-256 of:

- Vardo's build config version (`BUILD_CONFIG_VERSION` in `lib/docker/build-key.ts`; bump it when build flags or context handling change)
- the app id, so no image crosses apps
- the deployed commit SHA and the root directory
- the engine (`dockerfile`, `railpack`, `nixpacks`), its version, and the Dockerfile path for Dockerfile builds
- the build and start command overrides
- a SHA-256 of every build arg the build gets, and whether `.git` is in the context

Every app env var is a build arg today (`--build-arg` for Dockerfiles, `--env` for Railpack and Nixpacks), so any env change, runtime-only or not, rebuilds. The newest of the last 10 deploys with the key whose image is still on the host is reused; image reclaim may have removed older ones.

"Rebuild without cache" in the app's menu (`rebuild: "no-cache"` on the deploy API and the MCP tool) skips reuse and passes `--no-cache`. `rebuild: "force"` skips reuse but keeps the layer cache.

### Build cache setting

Each app has a Build cache setting (Settings → Build, stored in `apps.build_cache`) that applies to every deploy except rollbacks:

| Setting | Behavior |
| --- | --- |
| Use cache (default) | Reuse a matching image, keep the layer cache |
| Skip image reuse | Same as `rebuild: "force"` |
| Never use cache | Same as `rebuild: "no-cache"` |

A deploy that asks for a rebuild (`rebuild` on the API or MCP, or the app menu) overrides the setting. The deploy log states the mode that applied: `[deploy] Build cache: ...`.

### Compose builds

Each compose service with a `build:` gets its own key (`lib/docker/compose-build-reuse.ts`), from `docker compose config` for the slot:

- the build config version and the app id
- the git tree id of the service's context at the deployed commit, so a commit that leaves the directory alone keeps the key
- a SHA-256 of its Dockerfile (or `dockerfile_inline`), wherever it lives
- its build args, minus `VARDO_GIT_SHA` unless the Dockerfile declares `ARG VARDO_GIT_SHA`
- the rest of the build spec (target, labels, platforms and the like) and the Docker server version
- the commit, when the context includes `.git`

A service whose context is remote or outside the repo, or that uses `additional_contexts` or build secrets, gets no key and always builds; the log says why.

Keys go in `vardo-build-keys.yml` in the slot, passed to `compose build` only, which labels each image `vardo.build.key`. On the next deploy a service whose key labels a local image skips its build: Vardo builds `FROM <that image>` on the daemon's own builder with this slot's compose labels. That moves no layers (under a second) and keeps the per-slot labels image reclaim sorts by. Only the remaining services build; when none remain, the build is skipped. A rebuild skips the lookup but still labels the new images.

## Build registry

Admin → This instance → Build registry takes any OCI registry. Only builds on a build target push to it: the target pushes `<registry>/<app>:<build key>` (compose: `<app>-<service>:<key>`), this server pulls it and both drop the registry tag. A build on this server pushes nothing. Reuse still checks the registry by key when the host has no matching image.

There's no setting to push builds from this server too. The key includes the app id and a transferred app gets a new id, so another instance never matches the key; the copy would only duplicate disk this host already uses.

### Cleanup

Every 6 hours the `build-registry-cleanup` loop lists the registry's repos under the configured namespace and touches only those named `<app>` or `<app>-<service>` for an app on this instance. In each it keeps:

- the newest 3 tags (`ROLLBACK_IMAGES_RETAINED`)
- tags whose build key an image on this host carries in its `vardo.build.key` label
- tags built in the last day, so a build between push and pull keeps its image
- tags whose age it can't read

The rest are deleted by digest (`DELETE /v2/<name>/manifests/<digest>`), and a digest goes only when none of its tags is kept. The last run's counts or error show on the Build registry card. Repos of deleted apps are left as they were, at most 3 tags each. Give each instance its own namespace; two instances sharing one would prune each other's images.

The registry has to allow deletes: `REGISTRY_STORAGE_DELETE_ENABLED=true` for `registry:2`. Otherwise the card shows `The registry refuses deletes`.

Deleting a manifest frees no disk. `registry:2` frees blobs only in a garbage-collect pass. For a registry deployed as a Vardo app, add a cron job on it:

```
registry garbage-collect --delete-untagged /etc/docker/registry/config.yml
```

Run it weekly. Upstream warns that a push during garbage collection can lose layers, so pick an hour with no overflow builds.

## Image export

Measured 2026-10-10 on the same Mac against a throwaway `moby/buildkit:v0.34.0` on a remote buildx builder, set up as `vardo-bounded` is. The app is `create-next-app` 15.5.4 built from Nixpacks 1.41's generated Dockerfile (956 MB image); each run changes one source line, which reruns `npm ci` and `next build`. Seconds, mean of 3 to 5 runs.

| Daemon | Export | Export step | Whole build |
| --- | --- | --- | --- |
| Docker 29.4, overlay2 | `--load` (gzip) | 9.7 | 24.5 |
| | `--load`, provenance and SBOM off | 10.0 | 24.6 |
| | uncompressed | 5.7 | 20.4 |
| | zstd | 5.2 | 20.0 |
| Docker 29.9 (dind), containerd image store | `--load` (gzip) | 9.3 | 24.2 |
| | uncompressed | 4.9 | 20.0 |
| | zstd | 4.1 | 18.8 |

Most of the gzip cost is compressing the changed layers (6.2s of "exporting layers" vs 1.1s uncompressed). Attestations made no difference: buildx adds none for the docker exporter. On the containerd store uncompressed layers stay on disk as blobs (595 MB of content vs 348 MB gzip and 332 MB zstd); overlay2 unpacks and drops them either way.

So bounded builds pick their export from `docker info` (`lib/docker/build-export.ts`, read once per ten minutes):

- **containerd store** (`DriverStatus` has `driver-type: io.containerd.snapshotter.v1`; new Docker 29 installs default to it): `--output type=docker,compression=zstd`
- **overlay2 and other graph drivers**: `--output type=docker,compression=uncompressed`
- **unreadable**, or `VARDO_BUILD_EXPORT=load`: plain `--load`

Both add `--provenance=false --sbom=false`. Compose builds get the same export: when the store is known, Vardo prints compose's bake definition (`compose build --print`) and runs `docker buildx bake --set '*.output=…'` on it. When compose can't print one or a service uses build secrets, plain `compose build` runs as before. Railpack loads images itself and keeps gzip.

Not taken: giving `vardo-buildkit` the containerd worker on the host's containerd socket. Images would land in the store with no export at all, but build steps would run as host containerd tasks outside `vardo-buildkit`'s memory limit, it needs host mounts in `docker-compose.yml`, and it only works on the containerd store.

## Nixpacks on the bounded builder

Nixpacks builds run as Dockerfile builds. Vardo runs `nixpacks build <dir> --out <dir> --cache-key <appId>` with the app's env and overrides, which writes `.nixpacks/Dockerfile` into the build tree without building. It reads the plan's variables with `nixpacks plan` for the build args, then builds that Dockerfile like any other: on `vardo-bounded` under its memory limit and export, with the build tree as context and the `vardo.build.key` label. `.nixpacks/` is removed afterwards.

If generating fails, the log says so and Nixpacks builds the old way, on the daemon.

The cache mounts in 1.41's generated Dockerfile already follow the package manager: `/root/.npm` for npm, the pnpm store for pnpm, the yarn cache for yarn, plus `.next/cache` and `node_modules/.cache`. A pnpm mount on an npm app didn't reproduce, so nothing rewrites them. `--cache-key` scopes them per app, as for Railpack.

## Change: per-app Railpack cache key

Railpack names its cache mounts `next`, `node-modules` and `npm-install` with no app prefix, so every app on the daemon shared them. A build could read another app's `.next/cache`: a marker file written by one app's build was readable from a second app's build. Vardo now passes `--cache-key <appId>`, which scopes the mounts per app. Layer cache is unaffected: a fresh key on identical content rebuilt in 1.1s, and a source change took 10.9s with a key vs 9.8s without.

The cost is that a brand new app starts with an empty npm cache mount instead of borrowing another app's.

## Follow-ups

- Find why Railpack's dependency rebuild is slower than Nixpacks' (mise or install layer).
- Railpack still loads gzip layers; check whether its CLI can export uncompressed or zstd.

## Build plan and overrides

Before a Railpack or Nixpacks build, Vardo captures the engine's plan with the same env and overrides as the build:

- Railpack: `railpack info --format json [--build-cmd X] [--start-cmd Y] [--env K=V] <dir>`. `railpack plan` prints only the plan; `info` adds detected providers, resolved versions and detection logs. Neither needs BuildKit.
- Nixpacks: `nixpacks plan <dir> --format json [--build-cmd X] [--start-cmd Y] [--env K=V]`. It doesn't say why a provider matched, so Vardo lists the repo files that point to it.

The plan is stored on `deployment.build_plan` with app env values masked, summarized in the deploy log and shown on the deployment.

App settings carry a build command, start command and builder (Railpack or Nixpacks). Both engines take `--build-cmd` and `--start-cmd` on `build` and on the plan command. The builder applies when a compose-type app's repo has no compose file or Dockerfile. Blank means auto.
