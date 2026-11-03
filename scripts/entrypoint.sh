#!/bin/sh
set -e

# Routes the tunnel through vardo-wireguard as its address changes. As root: the app user can't change routes.
sh ./scripts/mesh-route.sh &

# Ensure nextjs user has access to the Docker socket.
# DOCKER_GID is set in docker-compose via group_add, but we need it
# as a proper group membership for gosu to inherit.
if [ -n "${DOCKER_GID:-}" ]; then
  getent group "$DOCKER_GID" >/dev/null 2>&1 || addgroup --gid "$DOCKER_GID" docker 2>/dev/null || true
  adduser nextjs "$(getent group "$DOCKER_GID" | cut -d: -f1)" 2>/dev/null || true
fi

# Ensure the app user can write to the Vardo home directory (host-mounted volume).
# Without this, deploys fail with EACCES when creating app directories.
# Only chown the top-level dirs — NOT recursive, to avoid slow startup and
# breaking apps that need root-owned files internally.
VARDO_HOME="${VARDO_HOME_DIR:-${VARDO_DIR:-/opt/vardo}}"
mkdir -p "$VARDO_HOME/apps" "$VARDO_HOME/images" "$VARDO_HOME/lifecycle"
chown nextjs:nodejs "$VARDO_HOME" "$VARDO_HOME/apps" "$VARDO_HOME/images" "$VARDO_HOME/lifecycle"
# Ensure the Traefik dynamic config directory is owned by the app user.
# Docker named volumes are initialised as root — chown here so writes succeed
# after privilege drop. Traefik (running as root) can still read/watch the dir.
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/traefik/dynamic}"
mkdir -p "$TRAEFIK_DYNAMIC_DIR"
chown -R nextjs:nodejs "$TRAEFIK_DYNAMIC_DIR"

# The worker waits for the console's migrations instead of running them.
if [ "${1:-}" = "worker" ]; then
  exec gosu nextjs node --enable-source-maps dist/worker.mjs
fi

# Run migrations as the app user.
gosu nextjs node scripts/migrate.mjs

# exec so tini's SIGTERM reaches Node. A `sh -c` or npx wrapper here swallows
# it and the container gets SIGKILLed instead.
# The preload records each request's real peer for client-IP checks (lib/security/client-ip.ts).
exec gosu nextjs node --import ./scripts/peer-address.mjs node_modules/next/dist/bin/next start
