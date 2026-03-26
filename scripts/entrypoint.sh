#!/bin/sh
set -e

# Set up mesh routing if WireGuard gateway is configured.
# Routes 10.99.0.0/24 (WireGuard mesh subnet) through the WireGuard container
# so the frontend can reach peer APIs over the encrypted tunnel.
if [ -n "${WIREGUARD_GATEWAY:-}" ]; then
  ip route add 10.99.0.0/24 via "$WIREGUARD_GATEWAY" 2>/dev/null || true
fi

# Drop to nextjs user, run migrations, start the app
exec gosu nextjs sh -c "node scripts/migrate.mjs && npx next start"
