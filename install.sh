#!/bin/bash
set -e

# Host — Self-hosted PaaS
# Install with: curl -fsSL https://get.host.joeyyax.dev | bash

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

HOST_DIR="/opt/host"
COMPOSE_FILE="docker-compose.yml"

log() { echo -e "${GREEN}▸${RESET} $1"; }
warn() { echo -e "${YELLOW}▸${RESET} $1"; }
error() { echo -e "${RED}▸${RESET} $1"; exit 1; }

# ── Preflight checks ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  Host — Self-hosted PaaS${RESET}"
echo -e "${DIM}  Deploy anything with Docker Compose${RESET}"
echo ""

# Root check
if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo bash install.sh"
fi

# Docker check
if ! command -v docker &> /dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  log "Docker installed"
else
  log "Docker found: $(docker --version | head -1)"
fi

# Docker Compose check
if ! docker compose version &> /dev/null; then
  error "Docker Compose plugin not found. Install Docker Desktop or the compose plugin."
fi

# Git check
if ! command -v git &> /dev/null; then
  log "Installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi

# ── Clone / update ─────────────────────────────────────────────────────────────

if [ -d "$HOST_DIR" ]; then
  log "Updating Host..."
  cd "$HOST_DIR"
  git pull --quiet
else
  log "Installing Host to $HOST_DIR..."
  git clone --depth 1 https://github.com/joeyyax/host.git "$HOST_DIR"
  cd "$HOST_DIR"
fi

# ── Configure ──────────────────────────────────────────────────────────────────

ENV_FILE="$HOST_DIR/.env.prod"

if [ ! -f "$ENV_FILE" ]; then
  log "Creating configuration..."

  # Prompt for required values
  read -p "  Domain for Host dashboard (e.g. host.example.com): " HOST_DOMAIN
  read -p "  Base domain for projects (e.g. example.com): " HOST_BASE_DOMAIN
  read -p "  Email for Let's Encrypt: " ACME_EMAIL

  # Generate secrets
  DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  AUTH_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 48)

  cat > "$ENV_FILE" <<EOF
HOST_DOMAIN=$HOST_DOMAIN
HOST_BASE_DOMAIN=$HOST_BASE_DOMAIN
DB_PASSWORD=$DB_PASSWORD
BETTER_AUTH_SECRET=$AUTH_SECRET
ACME_EMAIL=$ACME_EMAIL

# GitHub App (optional — configure later in Settings)
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY=
EOF

  log "Configuration saved to $ENV_FILE"
else
  log "Configuration exists at $ENV_FILE"
  source "$ENV_FILE"
fi

# ── Start ──────────────────────────────────────────────────────────────────────

log "Building Host..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --quiet

log "Starting Host..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

# ── Wait for healthy ───────────────────────────────────────────────────────────

log "Waiting for services to start..."
sleep 5

# Run migrations
log "Running database migrations..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T host npx drizzle-kit push --force 2>/dev/null || true

# Seed templates
log "Seeding templates..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T host node -e "
  fetch('http://localhost:3000/api/v1/templates/seed', { method: 'POST' })
    .then(r => r.json())
    .then(d => console.log('Templates:', d))
    .catch(() => console.log('Skipped (first user needs to register first)'));
" 2>/dev/null || true

# ── Done ───────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  Host is running!${RESET}"
echo ""
echo -e "  ${BOLD}Dashboard:${RESET}  https://${HOST_DOMAIN:-localhost}"
echo -e "  ${BOLD}Traefik:${RESET}    https://traefik.${HOST_BASE_DOMAIN:-localhost}"
echo ""
echo -e "  ${DIM}Create your first account to get started.${RESET}"
echo -e "  ${DIM}The first user is automatically an admin.${RESET}"
echo ""
echo -e "  ${DIM}To update:  cd $HOST_DIR && git pull && docker compose -f $COMPOSE_FILE --env-file .env.prod up -d --build${RESET}"
echo ""
