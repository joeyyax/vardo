#!/bin/bash
set -e

# Vardo — Self-hosted PaaS
# Install with: curl -fsSL https://get.host.joeyyax.dev | bash

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

HOST_DIR="/opt/vardo"
COMPOSE_FILE="docker-compose.yml"
DNS_OK=false

log() { echo -e "${GREEN}▸${RESET} $1"; }
warn() { echo -e "${YELLOW}▸${RESET} $1"; }
error() { echo -e "${RED}▸${RESET} $1"; exit 1; }

# ── Preflight checks ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  /\\   /__ _| |__ _| | ___${RESET}"
echo -e "${BOLD}  \\ \\ / / _\` | \`__/ _\` |/ _ \\${RESET}"
echo -e "${BOLD}   \\ V / (_| | | | (_| | (_) |${RESET}"
echo -e "${BOLD}    \\_/ \\__,_|_|  \\__,_|\\___/${RESET}"
echo ""
echo -e "${DIM}  Deploy everything. Own everything.${RESET}"
echo ""

# Root check
if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo bash install.sh"
fi

# ── System requirements ────────────────────────────────────────────────────────

# OS check
if [ -f /etc/os-release ]; then
  . /etc/os-release
  case "$ID" in
    ubuntu)
      MAJOR_VER=$(echo "$VERSION_ID" | cut -d. -f1)
      if [ "$MAJOR_VER" -lt 22 ] 2>/dev/null; then
        warn "Ubuntu $VERSION_ID detected — Ubuntu 22.04+ is recommended"
      else
        log "OS: Ubuntu $VERSION_ID"
      fi
      ;;
    debian)
      MAJOR_VER=$(echo "$VERSION_ID" | cut -d. -f1)
      if [ "$MAJOR_VER" -lt 12 ] 2>/dev/null; then
        warn "Debian $VERSION_ID detected — Debian 12+ is recommended"
      else
        log "OS: Debian $VERSION_ID"
      fi
      ;;
    *)
      warn "Detected $PRETTY_NAME — this script is tested on Ubuntu 22.04+ and Debian 12+"
      warn "Continuing anyway, but some steps may not work as expected"
      ;;
  esac
else
  warn "Could not detect OS — this script is tested on Ubuntu 22.04+ and Debian 12+"
fi

# RAM check
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
if [ "$TOTAL_RAM_MB" -gt 0 ] 2>/dev/null; then
  if [ "$TOTAL_RAM_MB" -lt 1024 ]; then
    error "Insufficient RAM: ${TOTAL_RAM_MB}MB detected, minimum 1GB required"
  elif [ "$TOTAL_RAM_MB" -lt 2048 ]; then
    warn "Low RAM: ${TOTAL_RAM_MB}MB detected — 2GB+ is recommended for production"
  else
    log "RAM: ${TOTAL_RAM_MB}MB"
  fi
fi

# Disk check
AVAILABLE_DISK_KB=$(df / 2>/dev/null | tail -1 | awk '{print $4}')
AVAILABLE_DISK_GB=$((AVAILABLE_DISK_KB / 1048576))
if [ "$AVAILABLE_DISK_GB" -lt 20 ] 2>/dev/null; then
  warn "Low disk space: ${AVAILABLE_DISK_GB}GB free — 20GB+ is recommended"
else
  log "Disk: ${AVAILABLE_DISK_GB}GB free"
fi

# ── Swap file ──────────────────────────────────────────────────────────────────

if [ "$TOTAL_RAM_MB" -gt 0 ] && [ "$TOTAL_RAM_MB" -lt 4096 ]; then
  if ! swapon --show 2>/dev/null | grep -q .; then
    log "Creating 2GB swap file (RAM is under 4GB)..."
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile > /dev/null
    if swapon /swapfile 2>/dev/null; then
      if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
      fi
      log "Swap enabled: 2GB"
    else
      rm -f /swapfile
      warn "Could not enable swap (ZFS or container — not fatal)"
    fi
  else
    log "Swap already active: $(swapon --show --noheadings --raw | awk '{sum+=$3} END {printf "%.0fMB", sum/1024/1024}')"
  fi
fi

# ── Unattended security updates ───────────────────────────────────────────────

log "Configuring unattended security updates..."
apt-get update -qq
apt-get install -y -qq unattended-upgrades > /dev/null 2>&1
dpkg-reconfigure -f noninteractive unattended-upgrades > /dev/null 2>&1
log "Unattended security updates enabled"

# ── Firewall ──────────────────────────────────────────────────────────────────

if ! command -v ufw &> /dev/null; then
  log "Installing ufw..."
  apt-get install -y -qq ufw > /dev/null 2>&1
fi

log "Configuring firewall..."
ufw allow 22/tcp > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
log "Firewall enabled (ports 22, 80, 443)"
# NOTE: Docker publishes ports directly via iptables and bypasses ufw by default.
# This is a known Docker behavior. To restrict container-published ports, use
# Docker's built-in --ip flag or network policies rather than ufw rules.

# ── Dependencies ──────────────────────────────────────────────────────────────

for dep in curl git; do
  if ! command -v $dep &> /dev/null; then
    log "Installing $dep..."
    apt-get update -qq > /dev/null 2>&1
    apt-get install -y -qq $dep > /dev/null 2>&1
  fi
done

# ── Docker ─────────────────────────────────────────────────────────────────────

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

# Docker log rotation
DAEMON_JSON="/etc/docker/daemon.json"
NEEDS_DOCKER_RESTART=false

if [ -f "$DAEMON_JSON" ]; then
  # Merge log config into existing daemon.json
  if command -v python3 &> /dev/null; then
    MERGED=$(python3 -c "
import json, sys
try:
    with open('$DAEMON_JSON') as f:
        existing = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    existing = {}
existing.setdefault('log-driver', 'json-file')
existing.setdefault('log-opts', {})
existing['log-opts'].setdefault('max-size', '10m')
existing['log-opts'].setdefault('max-file', '3')
print(json.dumps(existing, indent=2))
" 2>/dev/null)
    if [ -n "$MERGED" ]; then
      echo "$MERGED" > "$DAEMON_JSON"
      NEEDS_DOCKER_RESTART=true
      log "Docker log rotation configured (merged with existing daemon.json)"
    fi
  elif command -v jq &> /dev/null; then
    MERGED=$(jq '. + {"log-driver":"json-file"} | .["log-opts"] = (.["log-opts"] // {} | . + {"max-size":"10m","max-file":"3"})' "$DAEMON_JSON" 2>/dev/null)
    if [ -n "$MERGED" ]; then
      echo "$MERGED" > "$DAEMON_JSON"
      NEEDS_DOCKER_RESTART=true
      log "Docker log rotation configured (merged with existing daemon.json)"
    fi
  else
    warn "Cannot merge daemon.json — neither python3 nor jq available. Skipping log rotation config."
  fi
else
  mkdir -p /etc/docker
  cat > "$DAEMON_JSON" <<'DAEMONJSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
DAEMONJSON
  NEEDS_DOCKER_RESTART=true
  log "Docker log rotation configured"
fi

if [ "$NEEDS_DOCKER_RESTART" = true ]; then
  systemctl restart docker 2>/dev/null || true
  log "Waiting for Docker daemon to be ready..."
  DOCKER_WAIT=0
  while [ $DOCKER_WAIT -lt 30 ]; do
    if docker info > /dev/null 2>&1; then
      break
    fi
    sleep 1
    DOCKER_WAIT=$((DOCKER_WAIT + 1))
  done
  if [ $DOCKER_WAIT -ge 30 ]; then
    error "Docker daemon did not become ready within 30 seconds"
  fi
  log "Docker daemon is ready"
fi

# Git check
if ! command -v git &> /dev/null; then
  log "Installing git..."
  apt-get install -y -qq git > /dev/null 2>&1
fi

# ── Clone / update ─────────────────────────────────────────────────────────────

if [ -d "$HOST_DIR" ]; then
  log "Updating Host..."
  cd "$HOST_DIR"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "Local changes detected, stashing..."
    git stash --quiet
  fi
  git pull --quiet
else
  log "Installing Vardo to $HOST_DIR..."
  git clone --depth 1 https://github.com/joeyyax/vardo.git "$HOST_DIR"
  cd "$HOST_DIR"
fi

# ── Configure ──────────────────────────────────────────────────────────────────

ENV_FILE="$HOST_DIR/.env.prod"

if [ ! -f "$ENV_FILE" ]; then
  log "Creating configuration..."

  # Prompt for required values (skip if already set via env vars)
  if [ -z "$HOST_DOMAIN" ]; then
    read -p "  Domain for Vardo dashboard (e.g. host.example.com): " HOST_DOMAIN < /dev/tty
  fi
  if [ -z "$HOST_BASE_DOMAIN" ]; then
    read -p "  Base domain for projects (e.g. example.com): " HOST_BASE_DOMAIN < /dev/tty
  fi
  if [ -z "$ACME_EMAIL" ]; then
    read -p "  Email for Let's Encrypt: " ACME_EMAIL < /dev/tty
  fi

  # ── DNS validation (informational only — never blocks install) ────────────
  SERVER_IP=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
  if [ -n "$SERVER_IP" ]; then
    log "Server public IP: $SERVER_IP"

    if ! command -v dig &> /dev/null; then
      apt-get install -y -qq dnsutils > /dev/null 2>&1 || true
    fi

    if command -v dig &> /dev/null; then
      DOMAIN_IP=$(dig +short "$HOST_DOMAIN" 2>/dev/null | head -1)
    elif command -v host &> /dev/null; then
      DOMAIN_IP=$(host "$HOST_DOMAIN" 2>/dev/null | awk '/has address/ {print $4; exit}')
    else
      DOMAIN_IP=""
    fi

    if [ -n "$DOMAIN_IP" ] && [ "$DOMAIN_IP" = "$SERVER_IP" ]; then
      log "DNS verified: $HOST_DOMAIN -> $SERVER_IP"
      DNS_OK=true
    else
      if [ -n "$DOMAIN_IP" ]; then
        warn "DNS mismatch: $HOST_DOMAIN resolves to $DOMAIN_IP (this server is $SERVER_IP)"
      else
        warn "Could not resolve $HOST_DOMAIN — configure DNS when ready"
      fi
      echo ""
      echo -e "  ${DIM}Point these DNS records to this server:${RESET}"
      echo -e "    A   ${HOST_DOMAIN}           -> ${SERVER_IP}"
      echo -e "    A   *.${HOST_BASE_DOMAIN}    -> ${SERVER_IP}"
      echo ""
    fi
  fi

  # Optional services and backup storage are configured via the setup wizard
  COMPOSE_PROFILES=""
  FEATURE_METRICS="false"
  FEATURE_LOGS="false"

  echo ""

  # Generate secrets
  DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  AUTH_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 48)
  ENCRYPTION_MASTER_KEY=$(openssl rand -hex 32)
  GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)

  # Generate Traefik dashboard BasicAuth credentials
  TRAEFIK_DASH_PASS=$(openssl rand -base64 12)
  TRAEFIK_DASHBOARD_AUTH=$(printf 'admin:%s' "$(openssl passwd -apr1 "$TRAEFIK_DASH_PASS")" | sed 's/\$/\$\$/g')

  cat > "$ENV_FILE" <<EOF
HOST_DOMAIN=$HOST_DOMAIN
HOST_BASE_DOMAIN=$HOST_BASE_DOMAIN
DB_PASSWORD=$DB_PASSWORD
BETTER_AUTH_SECRET=$AUTH_SECRET
ENCRYPTION_MASTER_KEY=$ENCRYPTION_MASTER_KEY
GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET
ACME_EMAIL=$ACME_EMAIL
TRAEFIK_DASHBOARD_AUTH=$TRAEFIK_DASHBOARD_AUTH

# Optional services — controls which Docker Compose profiles are active.
# Add/remove profiles to enable/disable: logs (Loki + Promtail), metrics (cAdvisor)
COMPOSE_PROFILES=$COMPOSE_PROFILES

# Feature flags — set to "false" to hide disabled services from the UI
FEATURE_METRICS=$FEATURE_METRICS
FEATURE_LOGS=$FEATURE_LOGS

# GitHub App (optional — configure in setup wizard or Settings)
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY=
EOF

  chmod 600 "$ENV_FILE"
  log "Configuration saved to $ENV_FILE"
else
  log "Configuration exists at $ENV_FILE"
  source "$ENV_FILE"
fi

# ── Start ──────────────────────────────────────────────────────────────────────

log "Building Vardo (this may take a few minutes)..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build

log "Starting Host..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

# ── Wait for healthy ───────────────────────────────────────────────────────────

log "Waiting for Host to become healthy..."
TIMEOUT=60
INTERVAL=2
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T host curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    log "Host is healthy"
    break
  fi
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done
if [ $ELAPSED -ge $TIMEOUT ]; then
  warn "Health check timed out after ${TIMEOUT}s — continuing anyway"
fi

# NOTE: Migrations run automatically via the app's start script (drizzle-kit migrate).
# No need to run drizzle-kit push separately inside the container.

# Seed templates
log "Seeding templates..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T host node -e "
  fetch('http://localhost:3000/api/v1/templates/seed', { method: 'POST' })
    .then(r => r.json())
    .then(d => console.log('Templates:', d))
    .catch(() => console.log('Skipped (first user needs to register first)'));
" 2>/dev/null || true

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  ======================================${RESET}"
echo -e "${GREEN}${BOLD}  Host is running!${RESET}"
echo -e "${GREEN}${BOLD}  ======================================${RESET}"
echo ""
echo -e "  ${BOLD}Dashboard:${RESET}  https://${HOST_DOMAIN:-localhost}"
echo -e "  ${BOLD}Traefik:${RESET}    https://traefik.${HOST_BASE_DOMAIN:-localhost}"
if [ -n "$TRAEFIK_DASH_PASS" ]; then
  echo -e "  ${BOLD}Traefik login:${RESET} admin / ${TRAEFIK_DASH_PASS}"
fi
echo ""

# DNS records reminder
if [ "$DNS_OK" != true ] && [ -n "$SERVER_IP" ]; then
  echo -e "  ${YELLOW}${BOLD}DNS Records (required):${RESET}"
  echo -e "    A   ${HOST_DOMAIN:-<your-domain>}           -> ${SERVER_IP}"
  echo -e "    A   *.${HOST_BASE_DOMAIN:-<your-base-domain>}    -> ${SERVER_IP}"
  echo ""
fi

# Getting started
echo -e "  ${BOLD}Getting started:${RESET}"
if [ -n "$SERVER_IP" ]; then
  echo -e "    1. Visit ${BOLD}http://${SERVER_IP}${RESET} to complete setup (works before DNS)"
else
  echo -e "    1. Visit ${BOLD}https://${HOST_DOMAIN:-localhost}${RESET} to complete setup"
fi
echo -e "    2. The setup wizard will walk you through account creation, email, backups, and more"
echo ""

# Useful commands
echo -e "  ${BOLD}Useful commands:${RESET}"
echo -e "    ${DIM}View logs:${RESET}    docker compose -f $HOST_DIR/$COMPOSE_FILE --env-file $HOST_DIR/.env.prod logs -f"
echo -e "    ${DIM}Restart:${RESET}      docker compose -f $HOST_DIR/$COMPOSE_FILE --env-file $HOST_DIR/.env.prod restart"
echo -e "    ${DIM}Stop:${RESET}         docker compose -f $HOST_DIR/$COMPOSE_FILE --env-file $HOST_DIR/.env.prod down"
echo ""

# Update instructions
echo -e "  ${BOLD}To update Host:${RESET}"
echo -e "    cd $HOST_DIR && git pull && docker compose -f $COMPOSE_FILE --env-file .env.prod up -d --build"
echo ""

# Backup recommendations
echo -e "  ${BOLD}Backup recommendations:${RESET}"
echo -e "    ${DIM}- Back up $HOST_DIR/.env.prod (contains secrets)${RESET}"
echo -e "    ${DIM}- Back up PostgreSQL data: docker compose -f $HOST_DIR/$COMPOSE_FILE exec -T postgres pg_dumpall -U host > backup.sql${RESET}"
echo -e "    ${DIM}- Consider automated daily backups with cron${RESET}"
echo ""

# Security notes
echo -e "  ${BOLD}Security notes:${RESET}"
echo -e "    ${DIM}- UFW firewall is active (ports 22, 80, 443)${RESET}"
echo -e "    ${DIM}- Unattended security updates are enabled${RESET}"
echo -e "    ${DIM}- Docker log rotation is configured (10MB x 3 files per container)${RESET}"
echo -e "    ${DIM}- Docker bypasses UFW by default — use Docker network policies for container isolation${RESET}"
echo ""
