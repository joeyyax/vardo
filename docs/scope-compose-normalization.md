# Scope: Compose Normalization Pipeline

**Goal:** Treat user-provided docker-compose.yml as input/intent, not runtime truth. Vardo produces a fully managed runtime compose — stripping conflicts, extracting config, and surfacing changes transparently.

## Context

Today the deploy pipeline patches the user's compose in-place: inject Traefik labels, add vardo-network, maybe strip host ports. But it treats most of the file as sacred — hardcoded env vars, container_name collisions, host port bindings all pass through and cause deploy failures that aren't the user's fault.

The overlay mechanism (`docker-compose.override.yml`) already separates Vardo additions from user content. The missing piece is a **normalization step** that transforms user intent into safe runtime config, and a **transparency layer** that shows users what changed and why.

## Entry points (compose enters the system via)

- **New app flow** — paste compose or connect git repo (`app/(authenticated)/apps/new/`)
- **Adopt/discover** — import running containers (`app/api/v1/.../discover/.../import/`)
- **MCP adopt** — `lib/mcp/tools/adopt-app.ts`
- **Compose editor** — edit after creation (`app/(authenticated)/apps/[...slug]/compose-detail.tsx`)
- **Templates** — pre-built compose files (`templates/*.yaml`)

## In scope

### Increment 1: Compose analyzer (foundation)
- New `lib/docker/compose-analyze.ts` module
- Accepts a `ComposeFile` and returns a structured analysis:
  - Host port bindings (per service, with conflict detection against known ports)
  - Inline environment variables (candidates for extraction)
  - `container_name` directives (collision risks with blue-green slots)
  - `restart` policies (should be normalized to `unless-stopped`)
  - Missing `logging` config
  - Hardcoded volume paths that should be managed
- Pure function, no side effects — used by both UI and deploy pipeline

### Increment 2: Normalize step in deploy pipeline
- New `normalizeCompose(compose, options)` function called early in the pipeline
- Runs after `stripVardoInjections` and before Traefik/network injection
- Transformations:
  - **Strip host ports** from all Traefik-routed services (not just primary — all services on vardo-network with domains get stripped)
  - **Remove `container_name`** — Vardo manages naming via `-p` project flag and slot rotation. Hardcoded names break blue-green deploys
  - **Normalize `restart`** to `unless-stopped` (or whatever the app's restart policy is set to in Vardo)
  - **Strip inline env vars** that are already managed as Vardo env vars (prevents drift between compose and Vardo's encrypted store)
- Each transformation logs what it did: `[deploy] Stripped host port 3000:3000 from openwebui (routed via Traefik)`
- Returns both the normalized compose and a list of changes made

### Increment 3: Analysis API endpoint
- `GET /api/v1/organizations/[orgId]/apps/[appId]/compose/analysis`
- Also a variant for pre-creation: `POST /api/v1/organizations/[orgId]/compose/analyze` (accepts raw compose content)
- Returns the structured analysis from increment 1
- Used by the UI to show what Vardo will change

### Increment 4: Import-time review dialog
- When creating an app with compose (paste or git), show a review step before first deploy
- Groups findings by severity:
  - **Auto-fixed** (info): "Host port 3000 will be removed — Traefik handles routing"
  - **Recommended** (action): "Found 3 inline environment variables. Import as Vardo env vars? (encrypted, manageable per-environment)"
  - **Warning**: "container_name: myapp will be removed — Vardo manages container names for blue-green deploys"
- User can accept all, or toggle individual items
- Stores user preferences (e.g., "always strip host ports" vs "ask each time")
- Same dialog shown when compose content changes (edit, git pull detects changes)

### Increment 5: Env var extraction
- When the user opts in (from the dialog), inline `environment:` values get:
  - Created as Vardo env vars (encrypted, per-environment)
  - Removed from the compose `environment:` block
  - The compose gets `env_file: [.env]` if not already present
- Handles conflicts: if a Vardo env var already exists with a different value, flag it
- Preserves variable references (`${VAR}` syntax) — only extracts literal values

## Out of scope (not this time)

- **Logging injection** — adding Loki/Promtail config to services. Useful but separate concern, and many apps have their own logging needs
- **Resource limit defaults** — auto-setting CPU/memory limits. Too opinionated without per-app context
- **Volume normalization** — converting bind mounts to named volumes. High risk, apps depend on specific mount paths
- **Compose validation beyond structure** — checking if images exist, if referenced networks are valid, etc. Nice to have but separate
- **Automatic env var extraction** (without user consent) — always ask first, secrets could be involved
- **Multi-file compose support** — `docker-compose.override.yml` from user repos. The overlay mechanism is Vardo's, not the user's

## Increments summary

| # | Deliverable | Size | Depends on |
|---|------------|------|------------|
| 1 | Compose analyzer module | S | — |
| 2 | Normalize step in deploy pipeline | M | 1 |
| 3 | Analysis API endpoint | S | 1 |
| 4 | Import-time review dialog | M | 3 |
| 5 | Env var extraction flow | M | 4 |

## Dependencies

- Existing overlay mechanism (`buildVardoOverlay` / `slotComposeFiles`) — already in place, no changes needed
- Compose editor component — exists at `compose-detail.tsx`, will need to trigger re-analysis on edit

## Risks

- **Breaking existing deploys** — normalization could strip something an app actually needs. Mitigation: log all changes, make increment 2 conservative (only strip what we're confident about), add escape hatches per-app
- **container_name removal** — some apps reference each other by container name in their configs. Mitigation: when stripping container_name, ensure docker compose service discovery still works (it does — services reference each other by service name, not container name)
- **Env var extraction edge cases** — compose variables with shell expansion, multi-line values, YAML anchors. Mitigation: only extract simple key=value literals, leave complex cases alone
- **Port stripping for non-HTTP services** — databases, MQTT brokers, etc. genuinely need host ports. Mitigation: the analyzer should detect service type (by image name/known ports) and only recommend stripping HTTP ports that overlap with Traefik routing

## Estimate

**M** — 5 increments, each S-M individually. Increment 1-2 are the core, 3-5 build the UX on top. Could ship 1-2 in a day, 3-5 over the following days.
