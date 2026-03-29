#!/bin/sh
set -e

# Set up mesh routing if WireGuard gateway is configured.
if [ -n "${WIREGUARD_GATEWAY:-}" ]; then
  ip route add 10.99.0.0/24 via "$WIREGUARD_GATEWAY" 2>/dev/null || true
fi

# Ensure nextjs user has access to the Docker socket.
# DOCKER_GID is set in docker-compose via group_add, but we need it
# as a proper group membership for gosu to inherit.
if [ -n "${DOCKER_GID:-}" ]; then
  getent group "$DOCKER_GID" >/dev/null 2>&1 || addgroup --gid "$DOCKER_GID" docker 2>/dev/null || true
  adduser nextjs "$(getent group "$DOCKER_GID" | cut -d: -f1)" 2>/dev/null || true
fi

# Ensure the Traefik dynamic config directory is owned by the app user.
# Docker named volumes are initialised as root — chown here so writes succeed
# after privilege drop. Traefik (running as root) can still read/watch the dir.
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/traefik/dynamic}"
mkdir -p "$TRAEFIK_DYNAMIC_DIR"
chown -R nextjs:nodejs "$TRAEFIK_DYNAMIC_DIR"

# Drop to nextjs user, run migrations, start the app
exec gosu nextjs sh -c "node scripts/migrate.mjs && npx next start"
