#!/usr/bin/env bash
# The host `vardo` command. The /usr/local/bin/vardo shim execs this from the serving slot.
: "${VARDO_DIR:?VARDO_DIR is not set}"

# Self-deploy: the engine rotates the console through production/{blue,green}; the rest stays in project vardo.
SELF_DEPLOY=false
[ -L "$VARDO_DIR/apps/vardo/production/current" ] && SELF_DEPLOY=true

# Resolve compose file — self-deploy slot, legacy slot or legacy flat
if $SELF_DEPLOY; then
  COMPOSE_PATH="$VARDO_DIR/apps/vardo/production/current/docker-compose.yml"
  SRC_DIR="$VARDO_DIR/apps/vardo/production/current"
elif [ -L "$VARDO_DIR/apps/vardo/env/current" ]; then
  COMPOSE_PATH="$VARDO_DIR/apps/vardo/env/current/docker-compose.yml"
  SRC_DIR="$VARDO_DIR/apps/vardo/env/current"
else
  COMPOSE_PATH="$VARDO_DIR/docker-compose.yml"
  SRC_DIR="$VARDO_DIR"
fi

# Resolve install.sh — the serving slot's, falling back to root
INSTALL_SH="$VARDO_DIR/install.sh"
for candidate in "$VARDO_DIR/apps/vardo/production/current/install.sh" "$VARDO_DIR/apps/vardo/env/current/install.sh"; do
  if [ -f "$candidate" ]; then INSTALL_SH="$candidate"; break; fi
done
# The legacy slot's install.sh would run the legacy update.
if $SELF_DEPLOY && [ "$INSTALL_SH" = "$VARDO_DIR/apps/vardo/env/current/install.sh" ]; then
  INSTALL_SH="$VARDO_DIR/install.sh"
fi

# The console container, stopped ones too with -a.
console() {
  if $SELF_DEPLOY; then
    docker ps ${1:-} -q --filter "label=com.docker.compose.service=frontend" \
      --filter "label=com.docker.compose.project=vardo-production-$(basename "$(readlink "$VARDO_DIR/apps/vardo/production/current")")" | head -n 1
  else
    echo vardo-frontend
  fi
}

# The serving slot's worker, stopped ones too with -a. Empty before the first release with one.
worker() {
  if $SELF_DEPLOY; then
    docker ps ${1:-} -q --filter "label=com.docker.compose.service=worker" \
      --filter "label=com.docker.compose.project=vardo-production-$(basename "$(readlink "$VARDO_DIR/apps/vardo/production/current")")" | head -n 1
  else
    docker ps ${1:-} -q --filter "label=com.docker.compose.service=worker" --filter "label=com.docker.compose.project=vardo" | head -n 1
  fi
}

# Every container in project vardo, plus the serving console and worker on self-deploy.
stack() {
  docker ps ${1:-} -q --filter "label=com.docker.compose.project=vardo"
  if $SELF_DEPLOY; then console "${1:-}"; worker "${1:-}"; fi
}

# Runs a command in the console with stdin attached and VARDO_API_KEY passed through.
console_exec() {
  if $SELF_DEPLOY; then
    docker exec -i -e VARDO_API_KEY "$(console)" "$@"
  else
    docker compose -f "$COMPOSE_PATH" exec -T -e VARDO_API_KEY frontend "$@"
  fi
}

# Tells the console why it's stopping. Best effort.
stop_reason() {
  printf '{"reason":"%s","at":%s}\n' "$1" "$(date +%s)" > "$VARDO_DIR/lifecycle/stop-reason.json" 2>/dev/null || true
}

# Applies a changed .env: self-deploy seeds each slot from it, so redeploy.
apply_env() {
  if $SELF_DEPLOY; then
    bash "$INSTALL_SH" update --yes >&2
  else
    # up -d recreates the container; restart would keep the old environment.
    docker compose -f "$COMPOSE_PATH" up -d frontend >&2
  fi
}

case "${1:-}" in
  logs)
    shift
    if $SELF_DEPLOY && { [ $# -eq 0 ] || [ "$1" = frontend ]; }; then
      docker logs -f "$(console)"
    elif $SELF_DEPLOY && [ "$1" = worker ]; then
      W=$(worker -a)
      [ -n "$W" ] || { echo "No worker container. Run 'vardo update' to deploy one." >&2; exit 1; }
      docker logs -f "$W"
    else
      docker compose -f "$COMPOSE_PATH" logs -f "$@"
    fi
    ;;
  restart)  stop_reason "vardo restart"; if $SELF_DEPLOY; then docker restart $(stack); else docker compose -f "$COMPOSE_PATH" restart; fi ;;
  stop)     stop_reason "vardo stop"; if $SELF_DEPLOY; then docker stop $(stack); else docker compose -f "$COMPOSE_PATH" stop; fi ;;
  # docker start, not compose up: up would create a second console in project vardo.
  start)    if $SELF_DEPLOY; then docker start $(stack -a); else docker compose -f "$COMPOSE_PATH" up -d; fi ;;
  ps)       if $SELF_DEPLOY; then docker ps -a --filter "name=^vardo-"; else docker compose -f "$COMPOSE_PATH" ps; fi ;;
  worker)
    if [ "${2:-}" != "status" ]; then echo "Usage: vardo worker status" >&2; exit 2; fi
    W=$(worker -a)
    [ -n "$W" ] || { echo "No worker container. Run 'vardo update' to deploy one." >&2; exit 1; }
    docker inspect --format '{{.Name}}  {{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}  started {{.State.StartedAt}}  restarts {{.RestartCount}}' "$W" | sed 's#^/##'
    # 503 bodies still describe what's wrong, so print whatever comes back.
    docker exec "$W" curl -s -m 5 http://localhost:3001/healthz && echo || echo "/healthz didn't answer"
    ;;
  update)   shift; exec bash "$INSTALL_SH" update "$@" ;;
  migrate-self-deploy) shift; exec bash "$INSTALL_SH" migrate-self-deploy "$@" ;;
  doctor)   shift; exec bash "$INSTALL_SH" doctor "$@" ;;
  key)
    if [ "${2:-}" = "set" ]; then
      # For a rebuild: load the escrowed secrets before restoring a backup onto this instance.
      [ -w "$VARDO_DIR/.env" ] || { echo "Cannot write $VARDO_DIR/.env — run as root." >&2; exit 1; }
      if [ -t 0 ]; then
        read -rsp "Escrowed ENCRYPTION_MASTER_KEY: " NEW_KEY; echo "" >&2
        read -rsp "Escrowed BETTER_AUTH_SECRET (blank keeps the current one): " NEW_AUTH; echo "" >&2
      else
        read -r NEW_KEY
        read -r NEW_AUTH || true
      fi
      [[ "$NEW_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "The master key is 64 hex characters." >&2; exit 1; }
      if [ -n "$NEW_AUTH" ] && ! [[ "$NEW_AUTH" =~ ^[A-Za-z0-9_+/=.-]{32,}$ ]]; then
        echo "BETTER_AUTH_SECRET is at least 32 characters with no spaces or quotes." >&2
        exit 1
      fi
      echo "Anything this instance already encrypted becomes unreadable. Only do this on a fresh install." >&2
      if [ "${3:-}" != "--yes" ] && [ -t 0 ]; then
        read -rp "Replace the escrowed secrets? [y/N] " OK
        [[ "$OK" =~ ^[Yy] ]] || exit 1
      fi
      set_env() {
        local tmp; tmp=$(mktemp)
        if grep -q "^$1=" "$VARDO_DIR/.env"; then
          awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k, v; next } { print }' "$VARDO_DIR/.env" > "$tmp"
        else
          { cat "$VARDO_DIR/.env"; printf '%s=%s\n' "$1" "$2"; } > "$tmp"
        fi
        cat "$tmp" > "$VARDO_DIR/.env" && rm -f "$tmp"
      }
      set_env ENCRYPTION_MASTER_KEY "$NEW_KEY"
      [ -n "$NEW_AUTH" ] && set_env BETTER_AUTH_SECRET "$NEW_AUTH"
      apply_env
      echo "Escrowed secrets loaded." >&2
      exit 0
    fi
    # The secrets no backup carries. Printed to the terminal only — writing
    # them anywhere Vardo archives would put them beside the ciphertext they open.
    if [ ! -r "$VARDO_DIR/.env" ]; then
      echo "Cannot read $VARDO_DIR/.env — run as root." >&2
      exit 1
    fi
    grep -E '^(ENCRYPTION_MASTER_KEY|BETTER_AUTH_SECRET)=' "$VARDO_DIR/.env"
    echo "" >&2
    echo "Store both in a password manager. Without the master key, a restore onto a new" >&2
    echo "host leaves every app's env vars unreadable. Without the auth secret, two-factor" >&2
    echo "sign-in stops working." >&2
    ;;
  setup-token)
    # The token that opens first-run setup. Older installs get one on first ask.
    if [ ! -r "$VARDO_DIR/.env" ]; then
      echo "Cannot read $VARDO_DIR/.env — run as root." >&2
      exit 1
    fi
    TOKEN=$(grep -m1 '^SETUP_TOKEN=' "$VARDO_DIR/.env" | cut -d= -f2-)
    if [ -z "$TOKEN" ]; then
      [ -w "$VARDO_DIR/.env" ] || { echo "Cannot write $VARDO_DIR/.env — run as root." >&2; exit 1; }
      TOKEN=$(openssl rand -hex 16)
      printf 'SETUP_TOKEN=%s\n' "$TOKEN" >> "$VARDO_DIR/.env"
      apply_env
    fi
    echo "$TOKEN"
    ;;
  uninstall) exec bash "$INSTALL_SH" uninstall "$@" ;;
  shell)
    shift
    if $SELF_DEPLOY; then docker exec -it "$(console)" "${@:-sh}"; else docker compose -f "$COMPOSE_PATH" exec frontend "${@:-sh}"; fi
    ;;
  adopt)
    shift
    if [ -f "$SRC_DIR/scripts/adopt-cli.ts" ]; then
      tsx "$SRC_DIR/scripts/adopt-cli.ts" "$@"
    else
      echo "Error: adopt-cli.ts not found. Make sure Vardo is up to date."
      exit 1
    fi
    ;;
  backup)
    shift
    if [ "${1:-}" != "key" ] || [ $# -ne 1 ]; then
      echo "Usage: vardo backup key > key.txt" >&2
      echo "Then: age -d -i key.txt <archive>.age | tar -xz" >&2
      exit 2
    fi
    if [ -z "${ENCRYPTION_MASTER_KEY:-}" ]; then
      if [ ! -r "$VARDO_DIR/.env" ]; then
        echo "Set ENCRYPTION_MASTER_KEY, or run as root to read it from $VARDO_DIR/.env" >&2
        exit 1
      fi
      ENCRYPTION_MASTER_KEY=$(grep '^ENCRYPTION_MASTER_KEY=' "$VARDO_DIR/.env" | cut -d= -f2-)
    fi
    export ENCRYPTION_MASTER_KEY
    SRC="$SRC_DIR"
    [ -f "$SRC/scripts/backup-key.ts" ] || SRC="$VARDO_DIR"
    if [ ! -f "$SRC/scripts/backup-key.ts" ]; then
      echo "Error: backup-key.ts not found. Make sure Vardo is up to date." >&2
      exit 1
    fi
    # A slot's scripts/ links into the repo checkout; mount the real tree so the container sees it.
    SRC=$(dirname "$(cd "$SRC/scripts" && pwd -P)")
    if command -v tsx >/dev/null 2>&1; then
      tsx "$SRC/scripts/backup-key.ts"
    else
      # No host tsx: run it in a throwaway Node container. Needs no Vardo services.
      docker run --rm -q -e ENCRYPTION_MASTER_KEY -e NPM_CONFIG_UPDATE_NOTIFIER=false -v "$SRC:/src:ro" \
        node:22-slim npx -y tsx /src/scripts/backup-key.ts
    fi
    ;;
  import-data)
    # Load a pg_dump, SQL dump or volume tar into an app through the import API.
    shift
    if [ $# -lt 3 ] || [ $# -gt 4 ]; then
      echo "Usage: vardo import-data <org-id>/<app-id> <volume> <file|-|user@host:/path|https://url> [database]" >&2
      echo "Set VARDO_API_KEY to an API token for the app's organization." >&2
      exit 2
    fi
    TARGET="$1"; VOLUME="$2"; SRC="$3"; DB="${4:-}"
    [ -n "${VARDO_API_KEY:-}" ] || { echo "Set VARDO_API_KEY to an API token for the app's organization." >&2; exit 2; }
    [[ "$TARGET" =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$ ]] || { echo "Target is <org-id>/<app-id>." >&2; exit 2; }
    [[ "$VOLUME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid volume name: $VOLUME" >&2; exit 2; }
    [ -z "$DB" ] || [[ "$DB" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid database name: $DB" >&2; exit 2; }
    API="http://localhost:3000/api/v1/organizations/${TARGET%%/*}/apps/${TARGET#*/}/import"
    export VARDO_API_KEY
    # curl runs in the console container; the token stays off the host's process list.
    upload() {
      local q="volume=$VOLUME"
      [ -n "$DB" ] && q="$q&database=$DB"
      console_exec sh -c \
        'exec curl -sS -X PUT -T - -H "Authorization: Bearer $VARDO_API_KEY" -H "Content-Type: application/octet-stream" "$1"' \
        sh "$API?$q"
    }
    if [ "$SRC" = "-" ]; then
      OUT=$(upload)
    elif [ -f "$SRC" ]; then
      OUT=$(upload < "$SRC")
    elif [[ "$SRC" =~ ^https?://[^\"\\[:space:]]+$ ]]; then
      BODY="{\"volume\":\"$VOLUME\",${DB:+\"database\":\"$DB\",}\"source\":{\"type\":\"url\",\"url\":\"$SRC\"}}"
      OUT=$(printf '%s' "$BODY" | console_exec sh -c \
        'exec curl -sS -X POST --data-binary @- -H "Authorization: Bearer $VARDO_API_KEY" -H "Content-Type: application/json" "$1"' \
        sh "$API")
    elif [[ "$SRC" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/ ]]; then
      # Copied with this host's SSH keys first: a dropped connection mid-stream would upload a cut-off file.
      REMOTE_PATH="${SRC#*:}"
      QUOTED="'$(printf '%s' "$REMOTE_PATH" | sed "s/'/'\\\\''/g")'"
      STAGE=$(mktemp -d "$VARDO_DIR/.import-XXXXXX")
      trap 'rm -rf "$STAGE"' EXIT
      ssh -o BatchMode=yes -- "${SRC%%:*}" "cat -- $QUOTED" > "$STAGE/source" || { echo "Copying $SRC failed." >&2; exit 1; }
      OUT=$(upload < "$STAGE/source")
    else
      echo "No such file, URL or SSH path: $SRC" >&2
      exit 2
    fi
    echo "$OUT"
    [[ "$OUT" == *'"success":true'* ]] || exit 1
    ;;
  *)
    echo "Usage: vardo <command>"
    echo ""
    echo "Commands:"
    echo "  logs [service]   View logs (follows); logs worker for background work"
    echo "  worker status    Show the worker's container state and health"
    echo "  restart          Restart all services"
    echo "  stop             Stop all services"
    echo "  start            Start all services"
    echo "  ps               Show running containers"
    echo "  update           Redeploy Vardo (a legacy install offers to migrate first)"
    echo "  migrate-self-deploy  Move a legacy install onto Vardo's own deploy engine"
    echo "  doctor           Run health checks"
    echo "  key              Print the master key and auth secret (escrow them)"
    echo "  key set          Load escrowed secrets (fresh installs, before a restore)"
    echo "  setup-token      Print the first-run setup token"
    echo "  adopt <path>     Onboard existing repo with vardo.yaml"
    echo "  backup key       Print the age key that opens backup archives"
    echo "  import-data <org>/<app> <volume> <source> [db]  Load a dump or volume tar into an app"
    echo "  shell [cmd]      Open shell in frontend container"
    echo "  uninstall        Remove Vardo"
    ;;
esac
