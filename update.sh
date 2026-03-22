#!/usr/bin/env bash
set -euo pipefail

# Vardo — Self-hosted PaaS
# Update script for existing installations

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

HOST_DIR="${1:-/opt/vardo}"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
AUTO_YES=false
PREVIOUS_COMMIT=""

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --help|-h)
      echo "Usage: update.sh [HOST_DIR] [--yes]"
      echo ""
      echo "  HOST_DIR   Path to Vardo installation (default: /opt/vardo)"
      echo "  --yes, -y  Skip confirmation prompts"
      echo "  --help, -h Show this help"
      exit 0
      ;;
    *)
      # Treat non-flag args as HOST_DIR (only if it looks like a path)
      if [[ "$arg" != -* ]]; then
        HOST_DIR="$arg"
      fi
      ;;
  esac
done

log()   { echo -e "${GREEN}▸${RESET} $1"; }
warn()  { echo -e "${YELLOW}▸${RESET} $1"; }
error() { echo -e "${RED}▸${RESET} $1"; exit 1; }
info()  { echo -e "${CYAN}▸${RESET} $1"; }
step()  { echo -e "\n${BOLD}── $1 ──${RESET}"; }

# ── Header ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  Vardo — Update${RESET}"
echo -e "${DIM}  Self-hosted PaaS update script${RESET}"
echo ""

# ── Preflight checks ────────────────────────────────────────────────────────

step "Preflight checks"

# Root check
if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo bash update.sh"
fi

# Installation directory check
if [ ! -d "$HOST_DIR" ]; then
  error "Host installation not found at $HOST_DIR. Run install.sh first."
fi

if [ ! -f "$HOST_DIR/$COMPOSE_FILE" ]; then
  error "docker-compose.yml not found in $HOST_DIR. Is this a valid Host installation?"
fi

cd "$HOST_DIR"

if [ ! -f "$ENV_FILE" ]; then
  error "$ENV_FILE not found. Is this a configured Host installation?"
fi

# Docker check
if ! command -v docker &> /dev/null; then
  error "Docker is not installed."
fi

if ! docker compose version &> /dev/null; then
  error "Docker Compose plugin not found."
fi

# Git check
if ! command -v git &> /dev/null; then
  error "Git is not installed."
fi

if [ ! -d ".git" ]; then
  error "$HOST_DIR is not a git repository. Cannot update."
fi

log "Installation found at $HOST_DIR"
log "Docker: $(docker --version | head -1)"
log "Compose: $(docker compose version | head -1)"

# Migrate .env.prod → .env if needed (pre-v2 installations)
if [ -f ".env.prod" ] && [ ! -f ".env" ]; then
  log "Migrating .env.prod → .env"
  mv .env.prod .env
elif [ -f ".env.prod" ] && [ -f ".env" ]; then
  warn ".env.prod and .env both exist — using .env, remove .env.prod manually"
fi

# Migrate HOST_* → VARDO_* env vars if needed
if [ -f ".env" ] && grep -q "^HOST_" .env 2>/dev/null; then
  log "Renaming HOST_* env vars to VARDO_*"
  sed -i 's/^HOST_DOMAIN=/VARDO_DOMAIN=/' .env
  sed -i 's/^HOST_BASE_DOMAIN=/VARDO_BASE_DOMAIN=/' .env
  sed -i 's/^HOST_SERVER_IP=/VARDO_SERVER_IP=/' .env
  sed -i 's/^HOST_PROJECTS_DIR=/VARDO_PROJECTS_DIR=/' .env
  sed -i 's/^HOST_EXPOSE_PORTS=/VARDO_EXPOSE_PORTS=/' .env
fi

# Ensure COMPOSE_PROFILES includes production
if [ -f ".env" ] && ! grep -q "^COMPOSE_PROFILES=.*production" .env 2>/dev/null; then
  if grep -q "^COMPOSE_PROFILES=" .env; then
    sed -i 's/^COMPOSE_PROFILES=\(.*\)/COMPOSE_PROFILES=production,\1/' .env
  else
    echo "COMPOSE_PROFILES=production" >> .env
  fi
  log "Added 'production' to COMPOSE_PROFILES"
fi

# Ensure vardo-network exists
docker network create vardo-network 2>/dev/null || true

# ── Pre-update checks ───────────────────────────────────────────────────────

step "Checking for updates"

CURRENT_VERSION=$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)
PREVIOUS_COMMIT=$(git rev-parse HEAD)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

info "Current version: ${BOLD}$CURRENT_VERSION${RESET}"
info "Branch: ${BOLD}$CURRENT_BRANCH${RESET}"

# Fetch latest changes
git fetch origin "$CURRENT_BRANCH" --quiet 2>/dev/null || git fetch --quiet

# Check if there are incoming changes
INCOMING=$(git log HEAD..origin/"$CURRENT_BRANCH" --oneline 2>/dev/null || true)

if [ -z "$INCOMING" ]; then
  log "Already up to date. No updates available."
  exit 0
fi

echo ""
info "Incoming changes:"
echo -e "${DIM}"
git log HEAD..origin/"$CURRENT_BRANCH" --oneline --no-decorate | head -20
echo -e "${RESET}"

COMMIT_COUNT=$(git log HEAD..origin/"$CURRENT_BRANCH" --oneline | wc -l | tr -d ' ')
info "$COMMIT_COUNT commit(s) to apply"

# Confirmation
if [ "$AUTO_YES" = false ]; then
  echo ""
  read -p "  Apply update? [y/N] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    warn "Update cancelled."
    exit 0
  fi
fi

# ── Backup ───────────────────────────────────────────────────────────────────

step "Creating backup"

BACKUP_DIR="$HOST_DIR/backups"
BACKUP_TIMESTAMP=$(date +%Y%m%d%H%M%S)
BACKUP_FILE="$BACKUP_DIR/pre-update-${BACKUP_TIMESTAMP}.sql"

mkdir -p "$BACKUP_DIR"

log "Dumping PostgreSQL database..."
if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U host host > "$BACKUP_FILE" 2>/dev/null; then
  BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  log "Backup saved: $BACKUP_FILE ($BACKUP_SIZE)"
else
  warn "Database backup failed (is PostgreSQL running?)"
  warn "Continuing without backup..."
  rm -f "$BACKUP_FILE"
  BACKUP_FILE=""
fi

# ── Pull updates ─────────────────────────────────────────────────────────────

step "Pulling updates"

# Check for local changes that might conflict
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  warn "Local changes detected. Stashing..."
  git stash --quiet
  log "Changes stashed. Run 'git stash pop' after update if needed."
fi

if git pull origin "$CURRENT_BRANCH" --quiet; then
  NEW_VERSION=$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)
  log "Updated: $CURRENT_VERSION -> $NEW_VERSION"
else
  error "git pull failed. Resolve conflicts manually in $HOST_DIR."
fi

echo ""
info "Changes applied:"
echo -e "${DIM}"
git log "$PREVIOUS_COMMIT"..HEAD --oneline --no-decorate | head -20
echo -e "${RESET}"

# ── Rebuild and restart ──────────────────────────────────────────────────────

step "Rebuilding containers"

# COMPOSE_PROFILES from .env controls which services start.
log "Building images (this may take a few minutes)..."
docker compose -f "$COMPOSE_FILE" build --quiet

log "Restarting services..."
docker compose -f "$COMPOSE_FILE" up -d

# ── Wait for healthy ─────────────────────────────────────────────────────────

step "Waiting for Host to become healthy"

TIMEOUT=90
INTERVAL=3
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if docker compose -f "$COMPOSE_FILE" exec -T host curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    log "Host is healthy"
    break
  fi
  printf "."
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done
echo ""

if [ $ELAPSED -ge $TIMEOUT ]; then
  warn "Health check timed out after ${TIMEOUT}s"
  warn "The application may still be starting. Check logs with:"
  warn "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f host"
fi

# ── Post-update verification ─────────────────────────────────────────────────

step "Post-update verification"

NEW_VERSION=$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)
info "Version: ${BOLD}$NEW_VERSION${RESET}"

echo ""
info "Container status:"
docker compose -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null \
  || docker compose -f "$COMPOSE_FILE" ps

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  Update complete!${RESET}"
echo ""

# Source env for domain display
source "$ENV_FILE" 2>/dev/null || true
echo -e "  ${BOLD}Dashboard:${RESET}  https://${VARDO_DOMAIN:-localhost}"
echo -e "  ${BOLD}Version:${RESET}    $NEW_VERSION"
if [ -n "$BACKUP_FILE" ]; then
  echo -e "  ${BOLD}Backup:${RESET}     $BACKUP_FILE"
fi
echo ""

# ── Rollback instructions ────────────────────────────────────────────────────

echo -e "${DIM}  If something went wrong, rollback with:${RESET}"
echo ""
echo -e "${DIM}    cd $HOST_DIR${RESET}"
echo -e "${DIM}    git checkout $PREVIOUS_COMMIT${RESET}"
echo -e "${DIM}    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build${RESET}"
echo -e "${DIM}    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d${RESET}"
if [ -n "$BACKUP_FILE" ]; then
  echo ""
  echo -e "${DIM}  To restore the database:${RESET}"
  echo -e "${DIM}    cat $BACKUP_FILE | docker compose -f $COMPOSE_FILE --env-file $ENV_FILE exec -T postgres psql -U host host${RESET}"
fi
echo ""
