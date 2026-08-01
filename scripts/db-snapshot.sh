#!/usr/bin/env bash
# Save, restore and list local dev database snapshots.
#
#   scripts/db-snapshot.sh save local-seed
#   scripts/db-snapshot.sh pull-prod homelab      # read-only dump from the host
#   scripts/db-snapshot.sh load homelab
#   scripts/db-snapshot.sh list
#
# Only app-shaped tables move: project, app, domain. Users, orgs, sessions and
# secrets stay put, so a restore never logs you out or crosses an encryption key.
set -euo pipefail

DIR="${VARDO_SNAPSHOT_DIR:-$HOME/.vardo-snapshots}"
CONTAINER="${VARDO_PG_CONTAINER:-vardo-postgres}"
PROD_HOST="${VARDO_PROD_HOST:-10.0.0.19}"
TABLES=(project app domain)
mkdir -p "$DIR"

pg() { docker exec -i "$CONTAINER" psql -U host -d host "$@"; }

# Local org ids, resolved by name so a fresh database still works.
local_org() { pg -t -A -c "select id from organization where name = '$1' limit 1"; }

case "${1:-}" in
  save)
    name="${2:?usage: save <name>}"
    docker exec "$CONTAINER" pg_dump -U host -d host --data-only --no-owner \
      $(printf -- '-t %s ' "${TABLES[@]}") > "$DIR/$name.sql"
    echo "saved $DIR/$name.sql ($(wc -l < "$DIR/$name.sql") lines)"
    ;;

  pull-prod)
    name="${2:?usage: pull-prod <name>}"
    # Read-only against the host. Org ids are remapped to the local equivalents
    # so the two prod orgs do not collide on app_org_name_uniq.
    ssh "$PROD_HOST" "docker exec $CONTAINER pg_dump -U host -d host --data-only --no-owner \
      $(printf -- '-t %s ' "${TABLES[@]}")" > "$DIR/$name.sql"

    homelab=$(local_org Vardo)
    other=$(local_org Joey)
    prod_homelab=$(ssh "$PROD_HOST" "docker exec $CONTAINER psql -U host -d host -t -A -c \
      \"select id from organization where name = 'Homelab'\"")
    prod_other=$(ssh "$PROD_HOST" "docker exec $CONTAINER psql -U host -d host -t -A -c \
      \"select id from organization where name = 'Vardo'\"")

    sed -i '' "s/$prod_homelab/$homelab/g; s/$prod_other/$other/g" "$DIR/$name.sql"
    echo "pulled $DIR/$name.sql"
    ;;

  load)
    name="${2:?usage: load <name>}"
    file="$DIR/$name.sql"
    [ -f "$file" ] || { echo "no snapshot named $name in $DIR" >&2; exit 1; }
    # Snapshot what is there first — restoring is destructive.
    "$0" save "auto-before-$name" > /dev/null
    pg -q -c "truncate table $(IFS=,; echo "${TABLES[*]}") cascade"
    pg -q < "$file"
    pg -t -A -c "select (select count(*) from project)||' projects, '||\
      (select count(*) from app)||' apps, '||(select count(*) from domain)||' domains'"
    ;;

  list)
    ls -1 "$DIR"/*.sql 2>/dev/null | sed "s|$DIR/||; s|\.sql$||" || echo "none"
    ;;

  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
