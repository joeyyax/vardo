# Tunnel Provider Architecture Review

Reviewer context: I've read all mesh library code, DB schemas, API routes, docker-compose.yml, and the app-networking UI component before reviewing this document.

---

## Overall Assessment

The document is well-structured and the mesh relay approach is sound — it leverages existing infrastructure (WireGuard + Traefik file provider) cleanly. But it is scoped too broadly for a first pass. The ports-and-adapters abstraction is premature, and some design choices introduce unnecessary complexity for what should be a focused deliverable: "NAT'd nodes can receive GitHub webhooks."

---

## 1. The Provider Abstraction Is Premature

**Challenge**: The TunnelProvider interface, provider registry, and three-adapter design are speculative. Today's need is mesh relay. Cloudflare and Pangolin are listed as `(future)` — they have no implementation detail, no timeline, and no user asking for them.

The codebase has a clear pattern of building things when needed. Look at how mesh itself was built: concrete `lib/mesh/` functions, no `MeshProvider` interface, no registry. WireGuard is hardcoded because it's the only mesh transport. That's the right call — it kept things simple and shippable.

**Recommendation**: Build `lib/tunnel/mesh-relay.ts` as a set of plain functions (like `lib/mesh/heartbeat.ts`, `lib/mesh/peers.ts`). No interface, no registry, no `orchestrator.ts`. When the second provider arrives, extract the interface then. You'll have a real second data point to design the abstraction against, instead of guessing today.

What to cut from v1:
- `types.ts` TunnelProvider interface
- `registry.ts`
- `orchestrator.ts`
- `providers/` directory
- `cloudflare.ts`, `pangolin.ts` placeholder files
- `tunnelProviderKindEnum` — use a plain text column if you must future-proof, or just hardcode "mesh-relay" and add the enum when a second value exists

**Savings**: ~200 lines of abstraction code that would need to be maintained and potentially refactored anyway when real provider requirements emerge.

---

## 2. Scope Creep: App Exposure Should Be Phase 2

**Challenge**: The issue (#528) mentions two things: webhooks and optional app exposure. The document treats them as equal-scope deliverables. They are not.

Webhook exposure is:
- Single well-known path (`/api/v1/webhooks/github`)
- One route per private node
- No user-facing domain management
- Security surface is small (path-restricted, existing webhook signature verification)

App exposure is:
- Arbitrary domains/subdomains
- Per-app configuration UI
- Domain collision management across peers
- DNS/TLS implications
- Significant security surface (any app's traffic routed through relay)
- UI changes to app-networking.tsx

**Recommendation**: Ship webhook relay first. Defer the entire "Tunnel Access" UI section, app-targeted TunnelTarget, subdomain allocation, and all app-exposure sequence diagrams to a follow-up issue. The open questions section (#1, #2) only exist because of app exposure — they go away in a webhook-only scope.

---

## 3. Security Gaps

### 3.1 Relay-side route validation is underspecified

The document says "validate request (peer auth + allowlist)" but the allowlist mechanism is never defined. Where is it stored? Who manages it? Is it the `tunnel_config` table? The `mesh_peers` table? A new table?

Without a concrete design, this is a hand-wave. For v1 with webhook-only scope, the allowlist is simple: any authenticated mesh peer can request a webhook route. That's probably fine. But the document implies general-purpose allowlisting without defining it.

### 3.2 Traefik config file injection

The relay node writes Traefik dynamic config based on data received over the mesh API. If a compromised peer sends a malicious target (e.g., `originIp: "169.254.169.254"` to hit cloud metadata), the relay node would dutifully write a Traefik route to it.

**Mitigation needed**: The relay node must validate that `originIp` falls within the mesh subnet (`10.99.0.0/24`) and corresponds to the authenticated peer's actual `internalIp` from the `mesh_peers` table. Do not trust the `originIp` field from the request body.

### 3.3 Domain validation for webhook routes

The webhook route uses `PathPrefix('/api/v1/webhooks')` on the relay's host. But what prevents a peer from requesting a path like `/api/v1/webhooks/../../admin/config/export`? Path traversal in Traefik rules.

**Mitigation needed**: Validate the path is exactly `/api/v1/webhooks/github` (or a strict allowlist of webhook paths). Do not accept arbitrary path values.

### 3.4 No SSRF protection on the relay

The relay node proxies traffic to `http://10.99.0.X:PORT`. The port comes from the provision request. A compromised peer could request forwarding to port 5432 (Postgres), port 6379 (Redis), or port 8080 (Traefik dashboard).

**Mitigation needed**: Hard allowlist of forwardable ports. For webhook-only v1, the only valid port is 3000 (the Vardo frontend). For future app exposure, validate against the app's declared `containerPort`/`exposedPorts`.

### 3.5 Missing rate limit on the relay-side provision endpoint

The document mentions "10 per minute per peer" but the relay-side endpoint (`POST /api/v1/mesh/tunnel/provision`) uses `requireMeshPeer()` auth, not `withRateLimit()`. Rate limiting needs to be explicitly added. The existing mesh endpoints (heartbeat, sync) don't have rate limits either — they rely on the cron interval for natural throttling. Provision is user-triggered and needs explicit protection.

---

## 4. `tunnel_config` Table Is Over-Engineered

The document acknowledges invites use `system_settings` and then says "a dedicated table is cleaner." Maybe, but the codebase already has a pattern for this — `system_settings` with JSON values. The `tunnel_config` table stores one row per provider kind, with a JSONB `config` column. That's a key-value store with extra steps.

**Recommendation**: Use `system_settings` with keys like `tunnel:mesh-relay` and `tunnel:cloudflare`. Consistent with how GitHub app config (`getGitHubAppConfig()`) and invites already work. Add the dedicated table later if the data model actually becomes complex enough to warrant it.

---

## 5. `isPublic` Column on `mesh_peers` — Fine, But the Migration Is Overbuilt

Adding a boolean column is fine. But the migration plan describes a "migration script that prompts the admin." That's a new UI flow for a boolean flag.

**Simpler**: Add the column with `default(false)`. Add a note in the Settings > Mesh peer list showing which peers have endpoints. Let the admin toggle `isPublic` from the existing peer detail view. No migration script, no prompt flow, no special first-startup behavior.

---

## 6. The `listRoutes()` Method Queries the DB, Not the Provider

In the mesh relay provider, `listRoutes()` queries the `tunnel_routes` DB table. But the whole point of listing routes on a provider is reconciliation — checking what the provider *actually* has versus what the DB says. For mesh relay, that means listing Traefik config files on the relay node. The current implementation just reads the DB, which defeats the purpose.

If reconciliation isn't needed for v1, drop `listRoutes()` from the interface. If it is needed, the relay node needs an endpoint that lists its actual Traefik config files.

---

## 7. Conflicts with Existing Patterns

### 7.1 GitHub webhook URL update

The document says "the GitHub App webhook URL can be automatically updated to use the tunnel URL." The current webhook handler (`/api/v1/github/webhook/route.ts`) is a fixed URL. GitHub App webhooks are configured with a single URL in the GitHub App settings — not per-installation.

Changing the webhook URL requires either:
- Updating the GitHub App's webhook URL via the GitHub API (affects all installations)
- Using a per-installation webhook URL (GitHub Apps don't support this)

The document hand-waves this as "happens lazily." This needs a concrete plan. The likely answer is: the relay's public URL becomes the GitHub App's webhook URL, and the relay forwards to the private node. But that means the relay node needs to run the webhook handler too, or at minimum forward the raw request.

### 7.2 The relay needs the webhook secret

If the relay is just a dumb proxy (Traefik forwards HTTP to the private node), webhook signature verification happens on the private node — that's fine. But the document should explicitly state this. The relay node does NOT need the webhook secret, and it should NOT inspect webhook payloads.

---

## 8. What I'd Ship as V1

Minimal scope that solves the core problem:

1. **Add `isPublic` boolean to `mesh_peers`** — simple column addition
2. **Add `tunnel_routes` table** — but with `provider_kind` as a plain text column, not an enum
3. **Store tunnel config in `system_settings`** — no new `tunnel_config` table
4. **Build `lib/tunnel/mesh-relay.ts`** — plain functions, no interface/registry
5. **Add three mesh API routes** — provision, deprovision, health (on relay node)
6. **Add relay-side Traefik config writer** — webhook paths only
7. **Add "Tunnel" section to Settings > Mesh** — enable/disable, select relay peer
8. **Skip all app exposure UI and logic** — defer to phase 2

No provider abstraction. No Cloudflare/Pangolin stubs. No app exposure. No subdomain allocation. No multi-relay.

That's maybe 500-700 lines of new code instead of 1500+, and it ships the feature that actually unblocks homelab users from getting webhooks.

---

## Summary of Findings

| Area | Verdict |
|------|---------|
| Mesh relay approach | Sound. Leverages existing WireGuard + Traefik cleanly. |
| Provider abstraction | Premature. Build concrete, extract later. |
| App exposure in v1 | Scope creep. Defer to phase 2. |
| Security model | Good principles, underspecified details. Five gaps identified. |
| `tunnel_config` table | Over-engineered. Use `system_settings`. |
| DB schema | `tunnel_routes` is reasonable. Drop the provider kind enum. |
| GitHub webhook integration | Under-analyzed. Needs a concrete plan for URL management. |
| Codebase consistency | The abstraction pattern conflicts with how mesh was built. Functions > interfaces until you have two implementations. |
