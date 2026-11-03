#!/bin/sh
# Keeps the tunnel route pointed at vardo-wireguard's address on the mesh network, as root.
# VARDO_MESH_ROUTE_ONCE=1 runs one pass.

TUNNEL="${VARDO_MESH_TUNNEL:-10.99.0.0/24}"
WG="${VARDO_WG_CONTAINER:-vardo-wireguard}"
INTERVAL="${VARDO_MESH_ROUTE_INTERVAL:-10}"

# The address on the network named *_mesh: vardo_mesh under self-deploy, <project>_mesh under plain compose.
gateway() {
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}' "$WG" 2>/dev/null |
    awk '$1 ~ /_mesh$/ && $2 != "" { print $2; exit }'
}

pass() {
  gw=$(gateway)
  [ -n "$gw" ] || return 0
  have=$(ip route show "$TUNNEL" 2>/dev/null | awk '$2 == "via" { print $3; exit }')
  [ "$gw" = "$have" ] && return 0
  if ip route replace "$TUNNEL" via "$gw" 2>/dev/null; then
    echo "[mesh-route] $TUNNEL via $gw${have:+ (was $have)}"
  fi
}

if [ "${VARDO_MESH_ROUTE_ONCE:-}" = "1" ]; then
  pass
  exit 0
fi

while :; do
  pass
  sleep "$INTERVAL"
done
