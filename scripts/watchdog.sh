#!/bin/sh
# Restarts Vardo's core containers and the worker when Docker reports them unhealthy. See docs/watchdog.md.
# shellcheck disable=SC3043,SC2086,SC2046

set -u

INTERVAL="${WATCHDOG_INTERVAL:-30}"
APP_FAILS="${WATCHDOG_APP_FAILS:-3}"
DATA_FAILS="${WATCHDOG_DATA_FAILS:-10}"
MAX_RESTARTS="${WATCHDOG_MAX_RESTARTS:-3}"
WINDOW="${WATCHDOG_WINDOW:-1800}"
STATE_DIR="${WATCHDOG_STATE_DIR:-/state}"
APP_DIR="${WATCHDOG_APP_DIR:-/vardo-app}"
CONSOLE_ENV="${WATCHDOG_CONSOLE_ENV:-production}"
REDIS_CONTAINER="${WATCHDOG_REDIS_CONTAINER:-vardo-redis}"
BACKUP_HOLD="${WATCHDOG_BACKUP_HOLD:-1200}"
EVENTS_KEEP=200

# Prints "<action> <fails>". kind: app|data; health: Docker's status; deploy: idle|active|unknown;
# backups: hold while the console runs backup work inside BACKUP_HOLD, else anything.
decide() {
  local kind="$1" health="$2" fails="$3" recent="$4" deploy="$5" backups="${6:-idle}" limit
  if [ "$health" != "unhealthy" ]; then echo "ok 0"; return; fi
  fails=$((fails + 1))
  limit="$APP_FAILS"
  [ "$kind" = "data" ] && limit="$DATA_FAILS"
  if [ "$deploy" = "active" ]; then echo "deploy 0"; return; fi
  # Unknown deploy state usually means Redis is down: only the data stores act.
  if [ "$deploy" != "idle" ] && [ "$kind" != "data" ]; then echo "unknown $fails"; return; fi
  if [ "$fails" -lt "$limit" ]; then echo "wait $fails"; return; fi
  if [ "$backups" = "hold" ]; then echo "backups $fails"; return; fi
  if [ "$recent" -ge "$MAX_RESTARTS" ]; then echo "backoff $fails"; return; fi
  echo "restart 0"
}

now() { date +%s; }

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Appends one JSON line for the console to surface, keeping the newest EVENTS_KEEP.
record() {
  local file="$STATE_DIR/events.log"
  printf '{"ts":%s,"role":"%s","container":"%s","action":"%s","fails":%s}\n' "$(now)" "$1" "$2" "$3" "$4" >> "$file"
  tail -n "$EVENTS_KEEP" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  chmod 644 "$file" 2>/dev/null || true
}

# Restarts inside the window, pruning older ones.
recent_restarts() {
  local file="$STATE_DIR/$1.restarts" cutoff
  [ -f "$file" ] || { echo 0; return; }
  cutoff=$(($(now) - WINDOW))
  awk -v c="$cutoff" '$1 > c' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  wc -l < "$file" | tr -d ' '
}

# Docker health of a running container; anything else reads as "none".
health_of() {
  local out
  out=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null) || { echo none; return; }
  set -- $out
  if [ "${1:-}" = "running" ] && [ -n "${2:-}" ]; then echo "$2"; else echo none; fi
}

# The active console slot from the `current` symlink, else a pre-self-deploy vardo-frontend.
console_container() {
  local link="$APP_DIR/$CONSOLE_ENV/current" slot id
  if [ -L "$link" ]; then
    slot=$(basename "$(readlink "$link")")
    id=$(docker ps -q \
      --filter "label=com.docker.compose.project=vardo-$CONSOLE_ENV-$slot" \
      --filter "label=com.docker.compose.service=frontend" 2>/dev/null | head -n 1)
    if [ -n "$id" ]; then
      docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##'
      return
    fi
  fi
  echo vardo-frontend
}

# The active slot's worker, or nothing on a release without one.
worker_container() {
  local link="$APP_DIR/$CONSOLE_ENV/current" project=vardo id
  [ -L "$link" ] && project="vardo-$CONSOLE_ENV-$(basename "$(readlink "$link")")"
  id=$(docker ps -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=worker" 2>/dev/null | head -n 1)
  [ -n "$id" ] || return 0
  docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##'
}

# A draining worker reports healthy, but Docker's status can lag a check behind.
worker_draining() {
  docker exec "$1" curl -s -m 5 http://localhost:3001/healthz 2>/dev/null | grep -q '"draining":true'
}

# Stops the worker with its own stop_grace_period, then starts it, in the background so the drain doesn't hold the other checks.
restart_worker() {
  local name="$1" fails="$2" pidfile="$STATE_DIR/worker.restarting"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "skip $name: a restart is still draining it"
    return
  fi
  log "restart $name: unhealthy for $fails checks"
  (
    if docker stop "$name" > /dev/null 2>&1 && docker start "$name" > /dev/null 2>&1; then
      now >> "$STATE_DIR/worker.restarts"
      record worker "$name" restart "$fails"
    else
      log "restart $name failed"
      record worker "$name" restart-failed "$fails"
    fi
    rm -f "$pidfile"
  ) &
  echo $! > "$pidfile"
}

# idle, active (any deploy:active:* lease) or unknown.
deploy_state() {
  local out
  out=$(docker exec "$REDIS_CONTAINER" sh -c '[ -z "${REDIS_PASSWORD:-}" ] || export REDISCLI_AUTH="$REDIS_PASSWORD"; redis-cli --raw EVAL "return #redis.call(\"keys\", \"deploy:active:*\")" 0' 2>/dev/null) || { echo unknown; return; }
  case "$out" in
    0) echo idle ;;
    ''|*[!0-9]*) echo unknown ;;
    *) echo active ;;
  esac
}

# Whether the console or worker runs backups, restores or drills (any backup:busy:* key): busy, idle or unknown.
backup_state() {
  local out
  out=$(docker exec "$REDIS_CONTAINER" sh -c '[ -z "${REDIS_PASSWORD:-}" ] || export REDISCLI_AUTH="$REDIS_PASSWORD"; redis-cli --raw EVAL "return #redis.call(\"keys\", \"backup:busy:*\")" 0' 2>/dev/null) || { echo unknown; return; }
  case "$out" in
    0) echo idle ;;
    ''|*[!0-9]*) echo unknown ;;
    *) echo busy ;;
  esac
}

# hold while backup work runs, for up to BACKUP_HOLD seconds from the first unhealthy check that saw it.
backup_hold() {
  local file="$STATE_DIR/$1.backup-hold" since
  if [ "$(backup_state)" != busy ]; then rm -f "$file"; echo idle; return; fi
  [ -f "$file" ] || now > "$file"
  since=$(cat "$file" 2>/dev/null || now)
  if [ $(($(now) - since)) -lt "$BACKUP_HOLD" ]; then echo hold; else echo expired; fi
}

# One check of one container.
check() {
  local role="$1" kind="$2" name="$3" deploy="$4" fails_file="$STATE_DIR/$1.fails" fails health recent action next limit backups=idle
  fails=$(cat "$fails_file" 2>/dev/null || echo 0)
  health=$(health_of "$name")
  recent=$(recent_restarts "$role")
  if [ "$role" = worker ] && [ "$health" = unhealthy ] && worker_draining "$name"; then
    log "skip $name: draining"
    echo 0 > "$fails_file"
    return
  fi
  if [ "$role" = console ] || [ "$role" = worker ]; then
    if [ "$health" = unhealthy ]; then backups=$(backup_hold "$role"); else rm -f "$STATE_DIR/$role.backup-hold"; fi
  fi
  set -- $(decide "$kind" "$health" "$fails" "$recent" "$deploy" "$backups")
  action="$1" next="$2"
  echo "$next" > "$fails_file"
  case "$action" in
    restart)
      if [ "$role" = worker ]; then
        restart_worker "$name" "$((fails + 1))"
        return
      fi
      log "restart $name: unhealthy for $((fails + 1)) checks"
      if docker restart -t 30 "$name" > /dev/null 2>&1; then
        now >> "$STATE_DIR/$role.restarts"
        record "$role" "$name" restart "$((fails + 1))"
      else
        log "restart $name failed"
        record "$role" "$name" restart-failed "$((fails + 1))"
      fi
      ;;
    backoff)
      # Logged once, when the limit is first hit.
      limit="$APP_FAILS"
      [ "$kind" = "data" ] && limit="$DATA_FAILS"
      if [ "$next" -eq "$limit" ]; then
        log "backoff $name: $recent restarts in the last ${WINDOW}s, leaving it alone"
        record "$role" "$name" backoff "$next"
      fi
      ;;
    deploy) [ "$health" = "unhealthy" ] && log "skip $name: a deploy is running" ;;
    backups) log "hold $name: backup work is running (up to ${BACKUP_HOLD}s)" ;;
    unknown) log "skip $name: deploy state unreadable" ;;
    wait) log "unhealthy $name ($next)" ;;
  esac
}

tick() {
  if [ -f "$STATE_DIR/pause" ]; then return; fi
  # The console reads its age: older than 10 minutes opens host.watchdog-silent.
  touch "$STATE_DIR/alive"
  local deploy worker
  deploy=$(deploy_state)
  check console app "$(console_container)" "$deploy"
  worker=$(worker_container)
  [ -z "$worker" ] || check worker app "$worker" "$deploy"
  check traefik app vardo-traefik "$deploy"
  check postgres data vardo-postgres "$deploy"
  check redis data vardo-redis "$deploy"
}

main() {
  if [ "${VARDO_WATCHDOG:-true}" = "false" ]; then
    log "disabled by VARDO_WATCHDOG=false"
    rm -f "$STATE_DIR/alive"
    exec sleep 2147483647
  fi
  mkdir -p "$STATE_DIR"
  rm -f "$STATE_DIR"/*.fails
  log "watching every ${INTERVAL}s: console, worker, vardo-traefik, vardo-postgres, vardo-redis"
  trap 'exit 0' TERM INT
  while :; do
    tick
    sleep "$INTERVAL" &
    wait $!
  done
}

[ "${WATCHDOG_SOURCE_ONLY:-}" = "1" ] || main
