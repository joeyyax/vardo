#!/bin/sh
# Wraps the redis-stack entrypoint (docker-compose.yml, redis service).
# 1. exec redis-server so SIGTERM reaches it and `docker stop` ends with a final write.
#    The stock script runs it as a child and exits on SIGTERM, which kills it unsaved.
# 2. A volume with dump.rdb but no AOF starts with AOF off and turns it on at runtime.
#    Starting straight into appendonly yes ignores dump.rdb and comes up empty.
# shellcheck disable=SC3043

DATA="${REDIS_DATA_DIR:-/data}"
MANIFEST="$DATA/appendonlydir/appendonly.aof.manifest"

aof_ready() {
  [ -f "$MANIFEST" ] && grep -q ' type b$' "$MANIFEST"
}

enable_aof() {
  local i=0
  [ -z "${REDIS_PASSWORD:-}" ] || export REDISCLI_AUTH="$REDIS_PASSWORD"
  until redis-cli ping 2>/dev/null | grep -q PONG; do
    i=$((i + 1))
    [ "$i" -le 3600 ] || { echo "vardo-redis: gave up waiting to enable AOF" >&2; return 1; }
    sleep 1
  done
  redis-cli config set appendonly yes > /dev/null
  sleep 1
  while redis-cli info persistence | grep -qE '^aof_rewrite_(in_progress|scheduled):1'; do sleep 1; done
  if redis-cli info persistence | grep -q '^aof_last_bgrewrite_status:ok'; then
    echo "vardo-redis: AOF enabled from the existing snapshot"
  else
    echo "vardo-redis: AOF rewrite failed; running on snapshots only" >&2
  fi
}

if ! aof_ready && [ -f "$DATA/dump.rdb" ]; then
  echo "vardo-redis: dump.rdb without an AOF; loading it, then enabling AOF"
  REDIS_ARGS="${REDIS_ARGS:-} --appendonly no"
  export REDIS_ARGS
  enable_aof &
fi

# shellcheck disable=SC2016
script=$(sed 's/^\${CMD} /exec &/' /entrypoint.sh)
case "$script" in
  *"exec \${CMD}"*) ;;
  *) echo "vardo-redis: entrypoint layout changed; redis-server won't receive SIGTERM" >&2 ;;
esac
eval "$script"
