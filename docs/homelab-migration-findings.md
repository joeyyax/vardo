# Homelab Migration Findings (2026-03-26)

## install.sh Bugs

1. **Line 31 `VARDO_ROLE=""`** clobbers env vars passed to the script. Should be `VARDO_ROLE="${VARDO_ROLE:-}"` to preserve caller's value. Same pattern as `VARDO_DIR` on line 57-59 which correctly uses `:-`.

2. **Traefik container port binding failure is not recoverable.** When ports 80/443 are in use during initial `docker compose up -d`, the traefik container is created but without port bindings. After freeing the ports, `docker compose start traefik` starts the container but with no ports. Must `docker compose up -d traefik` (recreate) to get port bindings.

3. **No migration path for existing Traefik.** install.sh assumes a clean server. For servers with existing Traefik:
   - Need to copy ACME certs to Vardo's letsencrypt volume
   - Need to copy dynamic config files (external routes)
   - Need to handle the port conflict during install
   - Need to handle network migration (proxy -> vardo-network)

4. **`TRAEFIK_DOCKER_NETWORK` not in generated `.env`.** The docker-compose.yml supports `${TRAEFIK_DOCKER_NETWORK-vardo-network}` but `generate_env()` never writes it. Defaults to `vardo-network` which is correct for fresh installs, but migration scenarios may need it.

5. **ACME storage path mismatch.** Old Traefik commonly stores certs in `acme.json`. Vardo uses separate files per resolver (`acme-le.json`, `acme-le-dns.json`, etc.). Migration requires copying certs to all resolver paths.

## Migration Process (what worked)

### Sequence
1. Download install.sh, patch the VARDO_ROLE bug
2. Run install with `VARDO_DIR=/mnt/docker/vardo VARDO_ROLE=development` to avoid port conflict
3. Copy ACME certs from old Traefik volume to all Vardo resolver paths
4. Copy external routes (dynamic config YAML) to Vardo's traefik_dynamic volume
5. Update `.env` to production mode with domain, ACME email, CF_DNS_API_TOKEN
6. Stop old Traefik (`docker compose down` in old traefik dir)
7. Recreate Vardo's Traefik (`docker compose up -d traefik`) to get port bindings
8. Build and start frontend (`docker compose build frontend && docker compose up -d frontend`)
9. Migrate containers one-by-one: update compose files, recreate

### Container Network Migration
For each container stack:
- Replace `proxy` with `vardo-network` in docker-compose.yml (network references, labels)
- `docker compose up -d --force-recreate --remove-orphans`
- Brief restart per container (~1-2 seconds)

Containers with `traefik.docker.network=proxy` label won't route through Vardo's Traefik until the label is updated. Simply connecting to `vardo-network` via `docker network connect` is not sufficient if the label points to the old network.

### What doesn't need migration
- Backend containers (databases, redis, workers) on stack-internal networks — they don't need Traefik
- Host-network containers (plex, scrypted, samba, tailscale, cloudflare-ddns) — they bypass Docker networking entirely
- Background jobs (plextraktsync, r2-backup, scheduler) — no web interface

### External Routes
Traefik file-provider dynamic configs (for non-Docker services like Home Assistant, KVM, Proxmox) copied directly to Vardo's `traefik_dynamic` volume. No changes needed — same YAML format.

## Retired Services Cleaned Up
- joey-context (replaced by knowledge-server)
- mcp-memory (replaced by knowledge-server)
- agent-dashboard (merged into agents)
- 1password-mcp (merged into services-mcp)
- tdarr (unused)
- fileflows (unused)
- marreta (unused)
- kometa (unused)

## Issues Created
- #532 — Bind mount feature flag (merged in #537)
- #533 — Host network mode (merged in #537)
- #534 — GPU passthrough (merged in #537)
- #535 — Custom network modes (merged in #537)
- #529 — Webhook relay for NAT'd instances (future)
- #530 — Public app exposure (future)
