#!/usr/bin/env bash
set -euo pipefail

# Vardo — Self-hosted PaaS
# Install, update, diagnose, and manage your Vardo instance.
#
# Fresh install:  curl -fsSL https://vardo.run/install.sh | bash
# After install:  sudo bash /opt/vardo/install.sh

# ── Constants ─────────────────────────────────────────────────────────────────

COMPOSE_FILE="docker-compose.yml"
REPO_URL="https://github.com/joeyyax/vardo.git"

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

UNATTENDED=false
AUTO_YES=false
PURGE=false
DRY_RUN=false
VERBOSE=false
COMMAND=""
PLATFORM=""
VARDO_ROLE=""
PKG_MGR=""
DISTRO_ID=""
DISTRO_VERSION=""
DISTRO_TIER=0    # 1=bulletproof, 2=supported, 3=best-effort
INSTALL_LOG=""
STEP_CURRENT=0
STEP_TOTAL=0

# ── Platform detection ────────────────────────────────────────────────────────

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="macos" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        PLATFORM="wsl"
      else
        PLATFORM="linux"
      fi
      ;;
    *) PLATFORM="unknown" ;;
  esac

  # Set default VARDO_DIR based on platform (overridable via env var)
  if [[ "$PLATFORM" == "macos" ]]; then
    VARDO_DIR="${VARDO_DIR:-$HOME/vardo}"
  else
    VARDO_DIR="${VARDO_DIR:-/opt/vardo}"
  fi
}

# ── Distro detection & package manager abstraction ───────────────────────────

detect_distro() {
  if [[ "$PLATFORM" == "macos" ]]; then
    DISTRO_ID="macos"
    DISTRO_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
    PKG_MGR="brew"
    DISTRO_TIER=2
    return
  fi

  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_VERSION="${VERSION_ID:-0}"
  else
    DISTRO_ID="unknown"
    DISTRO_VERSION="0"
  fi

  # Determine package manager
  if command -v apt-get &>/dev/null; then
    PKG_MGR="apt"
  elif command -v dnf &>/dev/null; then
    PKG_MGR="dnf"
  elif command -v pacman &>/dev/null; then
    PKG_MGR="pacman"
  elif command -v apk &>/dev/null; then
    PKG_MGR="apk"
  elif command -v zypper &>/dev/null; then
    PKG_MGR="zypper"
  else
    PKG_MGR="unknown"
  fi

  # Assign tier
  case "$DISTRO_ID" in
    ubuntu)
      local major
      major=$(echo "$DISTRO_VERSION" | cut -d. -f1)
      if [ "${major:-0}" -ge 22 ] 2>/dev/null; then
        DISTRO_TIER=1
      else
        DISTRO_TIER=3
      fi
      ;;
    debian)
      local major
      major=$(echo "$DISTRO_VERSION" | cut -d. -f1)
      if [ "${major:-0}" -ge 12 ] 2>/dev/null; then
        DISTRO_TIER=1
      else
        DISTRO_TIER=3
      fi
      ;;
    fedora)
      DISTRO_TIER=2
      ;;
    rhel|rocky|almalinux|centos)
      DISTRO_TIER=2
      ;;
    arch|manjaro)
      DISTRO_TIER=2
      ;;
    alpine)
      DISTRO_TIER=2
      ;;
    *)
      DISTRO_TIER=3
      ;;
  esac
}

# Map generic package names to distro-specific names
pkg_name() {
  local name="$1"
  case "$PKG_MGR" in
    apt)
      case "$name" in
        dnsutils) echo "dnsutils" ;;
        *) echo "$name" ;;
      esac
      ;;
    dnf)
      case "$name" in
        dnsutils) echo "bind-utils" ;;
        *) echo "$name" ;;
      esac
      ;;
    pacman)
      case "$name" in
        dnsutils) echo "bind" ;;
        *) echo "$name" ;;
      esac
      ;;
    apk)
      case "$name" in
        dnsutils) echo "bind-tools" ;;
        *) echo "$name" ;;
      esac
      ;;
    zypper)
      case "$name" in
        dnsutils) echo "bind-utils" ;;
        *) echo "$name" ;;
      esac
      ;;
    *) echo "$name" ;;
  esac
}

pkg_update() {
  case "$PKG_MGR" in
    apt)
      if $VERBOSE; then
        run_cmd apt-get update -qq
      else
        run_cmd apt-get update -qq > /dev/null 2>&1
      fi
      ;;
    dnf)
      warn "Package installation for $PKG_MGR is not yet supported. Run 'dnf check-update' manually."
      return 1
      ;;
    pacman)
      warn "Package installation for $PKG_MGR is not yet supported. Run 'pacman -Sy' manually."
      return 1
      ;;
    apk)
      warn "Package installation for $PKG_MGR is not yet supported. Run 'apk update' manually."
      return 1
      ;;
    zypper)
      warn "Package installation for $PKG_MGR is not yet supported. Run 'zypper refresh' manually."
      return 1
      ;;
    *)
      warn "Cannot update packages: unknown package manager."
      return 1
      ;;
  esac
}

pkg_install() {
  case "$PKG_MGR" in
    apt)
      if $VERBOSE; then
        run_cmd apt-get install -y -qq "$@"
      else
        run_cmd apt-get install -y -qq "$@" > /dev/null 2>&1
      fi
      ;;
    dnf)
      warn "Package installation for $PKG_MGR is not yet supported. Install manually: $*"
      return 1
      ;;
    pacman)
      warn "Package installation for $PKG_MGR is not yet supported. Install manually: $*"
      return 1
      ;;
    apk)
      warn "Package installation for $PKG_MGR is not yet supported. Install manually: $*"
      return 1
      ;;
    zypper)
      warn "Package installation for $PKG_MGR is not yet supported. Install manually: $*"
      return 1
      ;;
    *)
      warn "Cannot install packages: unknown package manager. Install manually: $*"
      return 1
      ;;
  esac
}

pkg_check() {
  local pkg="$1"
  case "$PKG_MGR" in
    apt) dpkg -s "$pkg" &>/dev/null ;;
    dnf) rpm -q "$pkg" &>/dev/null ;;
    pacman) pacman -Q "$pkg" &>/dev/null ;;
    apk) apk info -e "$pkg" &>/dev/null ;;
    zypper) rpm -q "$pkg" &>/dev/null ;;
    *)
      warn "Cannot check package status for $PKG_MGR."
      return 1
      ;;
  esac
}

# ── Logging ──────────────────────────────────────────────────────────────────

setup_logging() {
  if [[ "$PLATFORM" == "macos" ]]; then
    INSTALL_LOG="$HOME/vardo-install.log"
  else
    INSTALL_LOG="/var/log/vardo-install.log"
  fi

  # Ensure log file is writable
  if touch "$INSTALL_LOG" 2>/dev/null; then
    chmod 600 "$INSTALL_LOG" 2>/dev/null || true
    exec > >(tee -a "$INSTALL_LOG") 2>&1
    log_to_file "Session started"
  else
    # Fall back to home directory if /var/log isn't writable
    INSTALL_LOG="$HOME/vardo-install.log"
    if touch "$INSTALL_LOG" 2>/dev/null; then
      chmod 600 "$INSTALL_LOG" 2>/dev/null || true
      exec > >(tee -a "$INSTALL_LOG") 2>&1
      log_to_file "Session started"
    else
      INSTALL_LOG=""
    fi
  fi
}

log_to_file() {
  if [ -n "${INSTALL_LOG:-}" ] && [ -w "$INSTALL_LOG" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$INSTALL_LOG"
  fi
}

# ── Utilities ─────────────────────────────────────────────────────────────────

log()     { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $1"; }
fail()    { echo -e "  ${RED}✗${RESET} $1"; exit 1; }
info()    { echo -e "  ${CYAN}·${RESET} $1"; }
dimln()   { echo -e "  ${DIM}$1${RESET}"; }

step() {
  if [ "$STEP_TOTAL" -gt 0 ]; then
    STEP_CURRENT=$((STEP_CURRENT + 1))
    echo -e "\n${BOLD}  [${STEP_CURRENT}/${STEP_TOTAL}] $1${RESET}"
  else
    echo -e "\n${BOLD}  $1${RESET}"
  fi
  log_to_file "STEP: $1"
}

# Execute a command, respecting --dry-run and --verbose modes
run_cmd() {
  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run] $*${RESET}"
    log_to_file "[dry-run] $*"
    return 0
  fi
  log_to_file "CMD: $*"
  "$@"
}

confirm() {
  if $UNATTENDED || $AUTO_YES; then return 0; fi
  local prompt="${1:-Continue?}"
  local default="${2:-n}"
  local yn
  if [[ "$default" == "y" ]]; then
    read -p "  $prompt [Y/n] " -r yn < /dev/tty
    [[ -z "$yn" || "$yn" =~ ^[Yy] ]]
  else
    read -p "  $prompt [y/N] " -r yn < /dev/tty
    [[ "$yn" =~ ^[Yy] ]]
  fi
}

_sed_i() {
  if [[ "$PLATFORM" == "macos" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

get_version() {
  if [ -d "$VARDO_DIR/.git" ]; then
    git -C "$VARDO_DIR" describe --tags --always 2>/dev/null \
      || git -C "$VARDO_DIR" rev-parse --short HEAD 2>/dev/null \
      || echo "unknown"
  else
    echo "unknown"
  fi
}

get_server_ip() {
  curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || echo ""
}

# Safely read a specific variable from .env without sourcing the whole file
env_get() {
  local key="$1" file="${2:-$VARDO_DIR/.env}"
  [ -f "$file" ] && grep -m1 "^${key}=" "$file" 2>/dev/null | cut -d= -f2- || echo ""
}

# Load common env vars into the current scope for display purposes
load_env_display() {
  VARDO_DOMAIN="${VARDO_DOMAIN:-$(env_get VARDO_DOMAIN)}"
  VARDO_BASE_DOMAIN="${VARDO_BASE_DOMAIN:-$(env_get VARDO_BASE_DOMAIN)}"
  VARDO_ROLE="${VARDO_ROLE:-$(env_get VARDO_ROLE)}"
}

is_production() { [[ "${VARDO_ROLE:-production}" == "production" ]]; }
is_dev() { [[ "${VARDO_ROLE:-}" == "development" ]]; }

# ── Detection ─────────────────────────────────────────────────────────────────

is_installed() {
  [[ -d "$VARDO_DIR" && -f "$VARDO_DIR/$COMPOSE_FILE" && -f "$VARDO_DIR/.env" ]]
}

container_count() {
  local status="${1:-running}"
  local count
  count=$(docker compose -f "$VARDO_DIR/$COMPOSE_FILE" ps --status "$status" --format json 2>/dev/null \
    | { grep -c '"Name"' 2>/dev/null || true; })
  echo "${count:-0}"
}

# ── Banner ────────────────────────────────────────────────────────────────────

print_banner() {
  echo ""
  echo -e "${BOLD}  Vardo${RESET}"
  echo -e "${DIM}  Deploy everything. Own everything.${RESET}"
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════════
# INSTALL
# ══════════════════════════════════════════════════════════════════════════════

check_root() {
  if [ "$EUID" -ne 0 ]; then
    fail "Please run as root: sudo bash install.sh"
  fi
}

get_ram_mb() {
  if [[ "$PLATFORM" == "macos" ]]; then
    local ram_bytes
    ram_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo "0")
    echo $((ram_bytes / 1024 / 1024))
  else
    local ram_kb
    ram_kb=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
    echo $((ram_kb / 1024))
  fi
}

# ── Disk space check ─────────────────────────────────────────────────────────

check_disk_space() {
  local check_path="/"
  if [[ "$PLATFORM" == "macos" ]]; then
    check_path="$HOME"
  fi

  local disk_avail_kb
  disk_avail_kb=$(df -k "$check_path" 2>/dev/null | tail -1 | awk '{print $4}')
  local disk_avail_mb=$(( ${disk_avail_kb:-0} / 1024 ))

  if [ "$disk_avail_mb" -lt 2048 ] 2>/dev/null; then
    fail "Insufficient disk space: ${disk_avail_mb}MB available (minimum 2GB required). Free up space on $(df "$check_path" | tail -1 | awk '{print $1}') and retry."
  elif [ "$disk_avail_mb" -lt 5120 ] 2>/dev/null; then
    warn "Disk: ${disk_avail_mb}MB free — 5GB+ recommended for Docker images and builds. Consider freeing space before continuing."
  fi
}

# ── Port conflict detection ──────────────────────────────────────────────────

check_port_in_use() {
  local port="$1"
  if [[ "$PLATFORM" == "macos" ]]; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null
  else
    ss -tlnp "sport = :$port" 2>/dev/null | grep -q LISTEN
  fi
}

get_port_process() {
  local port="$1"
  if [[ "$PLATFORM" == "macos" ]]; then
    local pid
    pid=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
      ps -p "$pid" -o comm= 2>/dev/null || echo "unknown (pid $pid)"
    fi
  else
    ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1 || echo "unknown"
  fi
}

check_critical_ports() {
  local ports_to_check=("80" "443" "3000")
  local conflicts=0

  for port in "${ports_to_check[@]}"; do
    if check_port_in_use "$port"; then
      local process_name
      process_name=$(get_port_process "$port")
      if [ -n "$process_name" ]; then
        warn "Port $port is in use by $process_name. This may conflict with Vardo services."
      else
        warn "Port $port is in use. This may conflict with Vardo services."
      fi
      conflicts=$((conflicts + 1))
    fi
  done

  if [ "$conflicts" -gt 0 ]; then
    warn "Stop conflicting services or they will prevent Vardo from starting."
  fi
}

find_free_port() {
  local port="$1"
  local extra_reserved="${2:-}"
  local max=$((port + 100))
  local reserved="7100 7200 7300 7400 $extra_reserved"
  while check_port_in_use "$port" || [[ " $reserved " == *" $port "* ]]; do
    port=$((port + 1))
    if [ "$port" -ge "$max" ]; then return 1; fi
  done
  echo "$port"
}

check_ports() {
  local ports_ok=true

  # Traefik ports — required for production only
  if is_production; then
    for port in 80 443; do
      if check_port_in_use "$port"; then
        local proc
        proc=$(get_port_process "$port")
        fail "Port $port is in use by ${proc:-unknown process} — Traefik needs it for TLS. Stop the conflicting service (e.g. 'systemctl stop nginx' or 'systemctl stop apache2') and retry."
      fi
    done
  fi

  # Service ports — detect conflicts and resolve
  local env_vars=("POSTGRES_PORT" "REDIS_PORT" "CADVISOR_PORT" "LOKI_PORT")
  local defaults=(7100 7200 7300 7400)
  local labels=("PostgreSQL" "Redis" "cAdvisor" "Loki")
  local assigned=()

  for i in "${!env_vars[@]}"; do
    local env_var="${env_vars[$i]}"
    local default="${defaults[$i]}"
    local label="${labels[$i]}"
    local current="${!env_var:-$default}"

    if check_port_in_use "$current"; then
      local alt
      alt=$(find_free_port "$((current + 1))" "${assigned[*]}")
      if [ -n "$alt" ]; then
        warn "$label: port $current in use — reassigning to $alt"
        export "${env_var}=$alt"
        assigned+=("$alt")
      else
        warn "$label: port $current in use — set $env_var in .env to override"
      fi
      ports_ok=false
    else
      assigned+=("$current")
    fi
  done

  if $ports_ok; then
    log "Ports available"
  fi
}

preflight_checks() {
  step "System checks"

  # Distro + tier info
  if [[ "$PLATFORM" == "macos" ]]; then
    log "macOS $DISTRO_VERSION"
  elif [[ "$PLATFORM" == "wsl" ]]; then
    log "WSL2 (Windows Subsystem for Linux)"
  elif [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    local tier_label=""
    case "$DISTRO_TIER" in
      1) tier_label="tier 1 — fully supported" ;;
      2) tier_label="tier 2 — supported, may need manual steps" ;;
      3) tier_label="tier 3 — best-effort, not tested" ;;
    esac

    case "$DISTRO_ID" in
      ubuntu)
        local major
        major=$(echo "$DISTRO_VERSION" | cut -d. -f1)
        if [ "${major:-0}" -lt 22 ] 2>/dev/null; then
          warn "Ubuntu $DISTRO_VERSION ($tier_label) — 22.04+ recommended. Older versions may have outdated Docker packages."
        else
          log "Ubuntu $DISTRO_VERSION ($tier_label)"
        fi
        ;;
      debian)
        local major
        major=$(echo "$DISTRO_VERSION" | cut -d. -f1)
        if [ "${major:-0}" -lt 12 ] 2>/dev/null; then
          warn "Debian $DISTRO_VERSION ($tier_label) — 12+ recommended."
        else
          log "Debian $DISTRO_VERSION ($tier_label)"
        fi
        ;;
      fedora)
        log "Fedora $DISTRO_VERSION ($tier_label)"
        ;;
      rhel|rocky|almalinux|centos)
        log "${PRETTY_NAME:-$DISTRO_ID $DISTRO_VERSION} ($tier_label)"
        ;;
      arch|manjaro)
        log "${PRETTY_NAME:-Arch Linux} ($tier_label)"
        ;;
      alpine)
        log "Alpine $DISTRO_VERSION ($tier_label)"
        ;;
      *)
        warn "${PRETTY_NAME:-$DISTRO_ID $DISTRO_VERSION} ($tier_label) — tested on Ubuntu 22.04+ and Debian 12+."
        if ! $UNATTENDED; then
          if ! confirm "This OS is not tested. Continue at your own risk?"; then
            fail "Installation cancelled. Use Ubuntu 22.04+, Debian 12+, or another supported distro."
          fi
        fi
        ;;
    esac

    if [ "$DISTRO_TIER" -eq 2 ]; then
      warn "This distro is tier 2 — Docker install via get.docker.com should work, but package installation may require manual steps."
    fi
  else
    warn "Unknown OS — tested on Ubuntu 22.04+ and Debian 12+. Install may fail on unsupported systems."
    if ! $UNATTENDED; then
      if ! confirm "Unknown OS detected. Continue at your own risk?"; then
        fail "Installation cancelled. Use a supported Linux distribution."
      fi
    fi
  fi

  # Package manager
  if [[ "$PLATFORM" != "macos" ]]; then
    if [ "$PKG_MGR" = "unknown" ]; then
      warn "No recognized package manager found. You will need to install dependencies manually."
    else
      log "Package manager: $PKG_MGR"
    fi
  fi

  # RAM
  local ram_mb
  ram_mb=$(get_ram_mb)
  if [ "$ram_mb" -gt 0 ] 2>/dev/null; then
    if [ "$ram_mb" -lt 1024 ]; then
      fail "Insufficient RAM: ${ram_mb}MB (minimum 1GB required). Upgrade your server or add swap space."
    elif [ "$ram_mb" -lt 2048 ]; then
      warn "RAM: ${ram_mb}MB — 2GB+ recommended for stable operation. Consider upgrading or adding swap."
    else
      log "RAM: ${ram_mb}MB"
    fi
  fi

  # Disk space (2GB minimum, 5GB warning)
  check_disk_space

  # General disk display
  local disk_kb disk_gb
  disk_kb=$(df / 2>/dev/null | tail -1 | awk '{print $4}')
  disk_gb=$((disk_kb / 1048576))
  if [ "$disk_gb" -lt 20 ] 2>/dev/null; then
    warn "Disk: ${disk_gb}GB free — 20GB+ recommended for images and builds."
  else
    log "Disk: ${disk_gb}GB free"
  fi

  # Ports
  check_ports
}

setup_swap() {
  # macOS manages its own swap
  [[ "$PLATFORM" == "macos" ]] && return

  local ram_mb
  ram_mb=$(get_ram_mb)

  if [ "$ram_mb" -gt 0 ] && [ "$ram_mb" -lt 4096 ]; then
    if ! swapon --show 2>/dev/null | grep -q .; then
      info "Creating 2GB swap file..."
      run_cmd fallocate -l 2G /swapfile 2>/dev/null || run_cmd dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
      run_cmd chmod 600 /swapfile
      run_cmd mkswap /swapfile > /dev/null
      if run_cmd swapon /swapfile 2>/dev/null; then
        grep -q '/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        log "Swap enabled: 2GB"
      else
        rm -f /swapfile
        warn "Could not enable swap (ZFS or container — not fatal)"
      fi
    fi
  fi
}

install_packages_macos() {
  step "Prerequisites"

  # Git — comes with Xcode CLI tools
  if command -v git &>/dev/null; then
    log "Git: $(git --version 2>/dev/null)"
  else
    fail "Git not found. Install Xcode command line tools: xcode-select --install"
  fi

  # Docker Desktop
  if docker info &>/dev/null 2>&1; then
    log "Docker: $(docker --version 2>/dev/null | head -1)"
  else
    if [ -d "/Applications/Docker.app" ]; then
      fail "Docker Desktop is installed but not running. Open Docker Desktop from Applications and wait for it to start, then retry."
    else
      fail "Docker Desktop not found. Download and install it from https://docker.com/products/docker-desktop then retry."
    fi
  fi

  # Compose check
  if docker compose version &>/dev/null; then
    log "Compose: $(docker compose version 2>/dev/null | sed 's/Docker Compose version //')"
  else
    fail "Docker Compose not available. Update Docker Desktop to the latest version."
  fi
}

install_packages_linux() {
  step "Packages"

  local to_install=()
  command -v curl &>/dev/null || to_install+=("curl")
  command -v git &>/dev/null || to_install+=("git")

  # Unattended upgrades (apt-only)
  local needs_unattended=false
  if [[ "$PKG_MGR" == "apt" ]]; then
    if ! pkg_check "unattended-upgrades"; then
      to_install+=("unattended-upgrades")
      needs_unattended=true
    fi
  fi

  # Docker
  local needs_docker=false
  if ! command -v docker &>/dev/null; then
    needs_docker=true
  fi

  if [ ${#to_install[@]} -eq 0 ] && ! $needs_docker; then
    log "All required packages installed"
    log "Docker: $(docker --version 2>/dev/null | head -1)"
    return
  fi

  # Show what will be installed
  if [ ${#to_install[@]} -gt 0 ]; then
    info "Will install via $PKG_MGR: ${to_install[*]}"
  fi
  if $needs_docker; then
    info "Will install: Docker Engine + Compose plugin"
  fi

  if ! $UNATTENDED && ! $AUTO_YES; then
    echo ""
    if ! confirm "Install these packages?"; then
      fail "Cannot continue without required packages. Install them manually and retry."
    fi
    echo ""
  fi

  # System packages
  if [ ${#to_install[@]} -gt 0 ]; then
    pkg_update || true
    pkg_install "${to_install[@]}" || fail "Failed to install packages: ${to_install[*]}. Check your package manager configuration and network connectivity."
    if $needs_unattended && [[ "$PKG_MGR" == "apt" ]]; then
      run_cmd dpkg-reconfigure -f noninteractive unattended-upgrades > /dev/null 2>&1 || true
    fi
    log "Installed: ${to_install[*]}"
  fi

  # Docker
  if $needs_docker; then
    info "Installing Docker (this may take a minute)..."
    if $DRY_RUN; then
      echo -e "  ${DIM}[dry-run] curl -fsSL https://get.docker.com | sh${RESET}"
    else
      curl -fsSL https://get.docker.com | sh > /dev/null 2>&1 || fail "Docker installation failed. Check https://docs.docker.com/engine/install/ for manual installation instructions."
    fi
    run_cmd systemctl enable docker > /dev/null 2>&1 || true
    run_cmd systemctl start docker || fail "Failed to start Docker daemon. Run 'systemctl status docker' to check for errors."
    log "Docker installed"
  else
    log "Docker: $(docker --version | head -1)"
  fi

  # Compose check
  if ! docker compose version &>/dev/null; then
    fail "Docker Compose plugin not found. Install it with: apt-get install docker-compose-plugin (or see https://docs.docker.com/compose/install/)"
  fi

  # Log rotation (Linux only — Docker Desktop manages its own)
  configure_docker_logging
}

install_packages() {
  if [[ "$PLATFORM" == "macos" ]]; then
    install_packages_macos
  else
    install_packages_linux
  fi
}

configure_docker_logging() {
  [[ "$PLATFORM" == "macos" ]] && return
  local daemon="/etc/docker/daemon.json"
  local needs_restart=false

  if [ -f "$daemon" ]; then
    if command -v python3 &>/dev/null; then
      local merged
      merged=$(python3 -c "
import json, sys
path = sys.argv[1]
try:
    with open(path) as f: c = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    c = {}
c.setdefault('log-driver','json-file')
c.setdefault('log-opts',{})
c['log-opts'].setdefault('max-size','10m')
c['log-opts'].setdefault('max-file','3')
print(json.dumps(c,indent=2))
" "$daemon" 2>/dev/null || true)
      if [ -n "$merged" ]; then
        if ! $DRY_RUN; then
          echo "$merged" > "$daemon"
        fi
        needs_restart=true
      fi
    fi
  else
    if ! $DRY_RUN; then
      mkdir -p /etc/docker
      cat > "$daemon" <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
    fi
    needs_restart=true
  fi

  if $needs_restart; then
    run_cmd systemctl restart docker 2>/dev/null || true
    local wait=0
    while [ $wait -lt 30 ]; do
      docker info > /dev/null 2>&1 && break
      sleep 1; wait=$((wait + 1))
    done
    if [ $wait -ge 30 ]; then
      fail "Docker daemon did not start within 30s after log rotation config. Run 'journalctl -u docker' to diagnose."
    fi
  fi
}

clone_repo() {
  step "Installation"

  if [ -d "$VARDO_DIR" ]; then
    log "Existing installation at $VARDO_DIR"
    cd "$VARDO_DIR"
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      warn "Local changes detected, stashing..."
      run_cmd git stash --quiet
    fi
    if ! run_cmd git pull --quiet; then
      fail "git pull failed in $VARDO_DIR. This may be caused by merge conflicts or authentication issues. Run 'cd $VARDO_DIR && git status' to inspect."
    fi
    log "Updated to latest"
  else
    info "Cloning to $VARDO_DIR..."
    run_cmd git clone --depth 1 "$REPO_URL" "$VARDO_DIR"
    cd "$VARDO_DIR"
    log "Installed to $VARDO_DIR"
  fi
}

generate_env() {
  local env_file="$VARDO_DIR/.env"

  if [ -f "$env_file" ]; then
    log "Configuration exists at $env_file"
    return
  fi

  step "Configuration"

  # Role selection
  if [ -z "${VARDO_ROLE:-}" ]; then
    if [[ "$PLATFORM" == "macos" ]]; then
      VARDO_ROLE="development"
      info "Role: development (default for macOS)"
    elif ! $UNATTENDED; then
      echo ""
      echo -e "  ${BOLD}Instance role:${RESET}"
      echo -e "    ${BOLD}1)${RESET} Production    Public server with TLS and domains"
      echo -e "    ${BOLD}2)${RESET} Staging       Testing environment (homelab, VPS)"
      echo -e "    ${BOLD}3)${RESET} Development   Local development"
      echo ""
      local role_choice
      read -rp "  Choose [1]: " role_choice < /dev/tty
      case "${role_choice:-1}" in
        1) VARDO_ROLE="production" ;;
        2) VARDO_ROLE="staging" ;;
        3) VARDO_ROLE="development" ;;
        *) VARDO_ROLE="production" ;;
      esac
    else
      VARDO_ROLE="production"
    fi
  fi
  [[ "$VARDO_ROLE" =~ ^(production|staging|development)$ ]] || fail "Invalid role: $VARDO_ROLE (expected: production, staging, development)"
  log "Role: $VARDO_ROLE"

  # Domain prompts — only for production and staging (optional for staging)
  if [[ "$VARDO_ROLE" == "production" ]]; then
    if $UNATTENDED; then
      [ -n "${VARDO_DOMAIN:-}" ] || fail "VARDO_DOMAIN is required in --unattended mode. Set it as an environment variable: VARDO_DOMAIN=host.example.com"
      [ -n "${VARDO_BASE_DOMAIN:-}" ] || fail "VARDO_BASE_DOMAIN is required in --unattended mode. Set it as an environment variable: VARDO_BASE_DOMAIN=example.com"
      [ -n "${ACME_EMAIL:-}" ] || fail "ACME_EMAIL is required in --unattended mode. Set it as an environment variable: ACME_EMAIL=you@example.com"
    else
      if [ -z "${VARDO_DOMAIN:-}" ]; then
        echo ""
        read -rp "  Domain for Vardo dashboard (e.g. host.example.com): " VARDO_DOMAIN < /dev/tty
      fi
      if [ -z "${VARDO_BASE_DOMAIN:-}" ]; then
        read -rp "  Base domain for projects (e.g. example.com): " VARDO_BASE_DOMAIN < /dev/tty
      fi
      if [ -z "${ACME_EMAIL:-}" ]; then
        read -rp "  Email for Let's Encrypt certificates: " ACME_EMAIL < /dev/tty
      fi
    fi

    # Basic input validation — reject shell metacharacters
    for var_name in VARDO_DOMAIN VARDO_BASE_DOMAIN ACME_EMAIL; do
      local val="${!var_name}"
      if [[ "$val" =~ [[:space:]\;\|\&\$\`\\\"\'\<\>] ]]; then
        fail "$var_name contains invalid characters. Use only alphanumeric characters, dots, hyphens, and @ symbols."
      fi
    done

    # DNS check (informational)
    local server_ip
    server_ip=$(get_server_ip)
    if [ -n "$server_ip" ]; then
      info "Server IP: $server_ip"

      if [[ "$PLATFORM" != "macos" ]]; then
        if ! command -v dig &>/dev/null; then
          local dns_pkg
          dns_pkg=$(pkg_name "dnsutils")
          pkg_install "$dns_pkg" 2>/dev/null || true
        fi
      fi

      local domain_ip=""
      if command -v dig &>/dev/null; then
        domain_ip=$(dig +short "$VARDO_DOMAIN" 2>/dev/null | head -1)
      elif command -v host &>/dev/null; then
        domain_ip=$(host "$VARDO_DOMAIN" 2>/dev/null | awk '/has address/ {print $4; exit}')
      fi

      if [ -n "$domain_ip" ] && [ "$domain_ip" = "$server_ip" ]; then
        log "DNS verified: $VARDO_DOMAIN → $server_ip"
      else
        echo ""
        warn "DNS not yet configured. Point these records to $server_ip:"
        dimln "  A   $VARDO_DOMAIN         → $server_ip"
        dimln "  A   *.$VARDO_BASE_DOMAIN  → $server_ip"
        echo ""
      fi
    fi
  elif [[ "$VARDO_ROLE" == "staging" ]]; then
    # Staging — domain is optional (may be behind existing reverse proxy)
    if [ -z "${VARDO_DOMAIN:-}" ] && ! $UNATTENDED; then
      echo ""
      read -rp "  Domain for Vardo dashboard (optional, press Enter to skip): " VARDO_DOMAIN < /dev/tty
      if [ -n "${VARDO_DOMAIN:-}" ]; then
        read -rp "  Base domain for projects: " VARDO_BASE_DOMAIN < /dev/tty
        read -rp "  Email for Let's Encrypt: " ACME_EMAIL < /dev/tty
      fi
    fi
  fi
  # Development role: no domain prompts at all

  if $DRY_RUN; then
    info "[dry-run] Would generate .env at $env_file"
    return
  fi

  # Generate secrets + instance identity
  local db_pass auth_secret enc_key webhook_secret instance_id
  db_pass=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  auth_secret=$(openssl rand -base64 32 | tr -d '/+=' | head -c 48)
  enc_key=$(openssl rand -hex 32)
  webhook_secret=$(openssl rand -hex 32)
  if command -v uuidgen &>/dev/null; then
    instance_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  elif [ -f /proc/sys/kernel/random/uuid ]; then
    instance_id=$(cat /proc/sys/kernel/random/uuid)
  else
    # RFC 4122 v4: set version (4) and variant (8/9/a/b) bits
    local hex
    hex=$(openssl rand -hex 16)
    instance_id="${hex:0:8}-${hex:8:4}-4${hex:13:3}-$(printf '%x' $(( 0x${hex:16:2} & 0x3f | 0x80 )))${hex:18:2}-${hex:20:12}"
  fi

  if [[ "$VARDO_ROLE" == "development" ]]; then
    # Dev .env — minimal, no TLS/domain config
    cat > "$env_file" <<EOF
VARDO_ROLE=development
VARDO_INSTANCE_ID=$instance_id
DB_PASSWORD=$db_pass
BETTER_AUTH_SECRET=$auth_secret
ENCRYPTION_MASTER_KEY=$enc_key
GITHUB_WEBHOOK_SECRET=$webhook_secret
EOF
  elif [[ "$VARDO_ROLE" == "staging" ]] && [ -z "${VARDO_DOMAIN:-}" ]; then
    # Staging without domain — no TLS, no Traefik auth
    cat > "$env_file" <<EOF
VARDO_ROLE=staging
VARDO_INSTANCE_ID=$instance_id
COMPOSE_PROFILES=production
DB_PASSWORD=$db_pass
BETTER_AUTH_SECRET=$auth_secret
ENCRYPTION_MASTER_KEY=$enc_key
GITHUB_WEBHOOK_SECRET=$webhook_secret
EOF
  else
    # Production or staging with domain — full config
    local traefik_pass traefik_auth
    traefik_pass=$(openssl rand -base64 12)
    traefik_auth=$(printf 'admin:%s' "$(openssl passwd -apr1 "$traefik_pass")" | sed 's/\$/\$\$/g')

    cat > "$env_file" <<EOF
VARDO_ROLE=${VARDO_ROLE}
VARDO_INSTANCE_ID=$instance_id
COMPOSE_PROFILES=production
VARDO_DOMAIN=${VARDO_DOMAIN}
VARDO_BASE_DOMAIN=${VARDO_BASE_DOMAIN}
DB_PASSWORD=$db_pass
BETTER_AUTH_SECRET=$auth_secret
ENCRYPTION_MASTER_KEY=$enc_key
GITHUB_WEBHOOK_SECRET=$webhook_secret
ACME_EMAIL=${ACME_EMAIL}
TRAEFIK_DASHBOARD_AUTH=$traefik_auth

# GitHub App (optional — configure in setup wizard or Settings)
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY=
EOF
  fi

  # Append port overrides if any were reassigned during preflight
  local env_vars=("POSTGRES_PORT" "REDIS_PORT" "CADVISOR_PORT" "LOKI_PORT")
  local defaults=(7100 7200 7300 7400)
  local has_overrides=false

  for i in "${!env_vars[@]}"; do
    local env_var="${env_vars[$i]}"
    local default="${defaults[$i]}"
    local current="${!env_var:-$default}"
    if [ "$current" != "$default" ]; then
      if ! $has_overrides; then
        echo "" >> "$env_file"
        echo "# Port overrides (reassigned to avoid conflicts)" >> "$env_file"
        has_overrides=true
      fi
      echo "${env_var}=${current}" >> "$env_file"
    fi
  done

  chmod 600 "$env_file"
  log "Configuration saved"
}

build_and_start() {
  step "Starting Vardo"

  # Pre-start port conflict check
  check_critical_ports

  run_cmd docker network create vardo-network 2>/dev/null || true

  if is_dev; then
    # Dev mode: start infrastructure only (no frontend profile)
    info "Starting infrastructure services (Postgres, Redis, Traefik)..."
    run_cmd docker compose -f "$VARDO_DIR/$COMPOSE_FILE" up -d
  else
    info "Building containers (this may take a few minutes)..."
    if $VERBOSE; then
      run_cmd docker compose -f "$VARDO_DIR/$COMPOSE_FILE" build
    else
      run_cmd docker compose -f "$VARDO_DIR/$COMPOSE_FILE" build --quiet
    fi

    info "Starting services..."
    run_cmd docker compose -f "$VARDO_DIR/$COMPOSE_FILE" up -d
  fi
}

wait_healthy() {
  local timeout="${1:-60}"
  local interval="${2:-2}"
  local elapsed=0
  local container="${3:-frontend}"

  if $DRY_RUN; then
    info "[dry-run] Would wait for health check"
    return 0
  fi

  info "Waiting for Vardo to become healthy..."
  while [ $elapsed -lt "$timeout" ]; do
    if docker compose -f "$VARDO_DIR/$COMPOSE_FILE" exec -T "$container" \
      curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
      log "Vardo is healthy"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  warn "Health check timed out after ${timeout}s — may still be starting. Check logs with: docker compose -f $VARDO_DIR/$COMPOSE_FILE logs frontend"
  return 1
}

seed_templates() {
  if $DRY_RUN; then return 0; fi
  docker compose -f "$VARDO_DIR/$COMPOSE_FILE" exec -T frontend node -e "
    fetch('http://localhost:3000/api/v1/templates/seed', { method: 'POST' })
      .then(r => r.json())
      .then(d => console.log('Templates:', JSON.stringify(d)))
      .catch(() => {});
  " 2>/dev/null || true
}

print_install_summary() {
  local version
  version=$(get_version)
  load_env_display

  echo ""
  echo -e "${GREEN}${BOLD}  Vardo is running!${RESET}"
  echo ""
  echo -e "  ${BOLD}Role${RESET}        $VARDO_ROLE"
  echo -e "  ${BOLD}Version${RESET}     $version"
  echo -e "  ${BOLD}Directory${RESET}   $VARDO_DIR"

  if [ -n "${INSTALL_LOG:-}" ]; then
    echo -e "  ${BOLD}Log${RESET}         $INSTALL_LOG"
  fi

  if is_dev; then
    echo ""
    echo -e "  ${BOLD}Next steps${RESET}"
    dimln "  1. cd $VARDO_DIR"
    dimln "  2. pnpm install"
    dimln "  3. pnpm dev"
    dimln "  4. Visit http://localhost:3000 to complete setup"
  elif [ -n "${VARDO_DOMAIN:-}" ]; then
    echo -e "  ${BOLD}Dashboard${RESET}   https://${VARDO_DOMAIN}"
    echo ""
    local server_ip
    server_ip=$(get_server_ip)
    if [ -n "$server_ip" ]; then
      echo -e "  ${BOLD}Next step${RESET}   Visit ${BOLD}http://${server_ip}${RESET} to complete setup"
      dimln "            (works before DNS propagates)"
    else
      echo -e "  ${BOLD}Next step${RESET}   Visit the dashboard to complete setup"
    fi
  else
    echo ""
    echo -e "  ${BOLD}Next step${RESET}   Visit ${BOLD}http://localhost:3000${RESET} to complete setup"
  fi
  echo ""

  local sudo_prefix=""
  [[ "$PLATFORM" != "macos" ]] && sudo_prefix="sudo "

  echo -e "  ${BOLD}Commands${RESET}"
  dimln "  View logs       docker compose -f $VARDO_DIR/$COMPOSE_FILE logs -f"
  dimln "  Restart         docker compose -f $VARDO_DIR/$COMPOSE_FILE restart"
  dimln "  Update          ${sudo_prefix}bash $VARDO_DIR/install.sh update"
  dimln "  Health check    ${sudo_prefix}bash $VARDO_DIR/install.sh doctor"
  echo ""
}

do_install() {
  STEP_TOTAL=7
  STEP_CURRENT=0

  [[ "$PLATFORM" != "macos" ]] && check_root
  preflight_checks
  setup_swap
  install_packages
  clone_repo
  generate_env
  build_and_start
  if ! is_dev; then
    wait_healthy 60 2
    seed_templates
  fi
  print_install_summary
}

# ══════════════════════════════════════════════════════════════════════════════
# UPDATE
# ══════════════════════════════════════════════════════════════════════════════

run_env_migrations() {
  local env_file="$VARDO_DIR/.env"

  # .env.prod → .env (pre-v2) — must run before the .env existence check
  if [ -f "$VARDO_DIR/.env.prod" ] && [ ! -f "$env_file" ]; then
    mv "$VARDO_DIR/.env.prod" "$env_file"
    log "Migrated .env.prod → .env"
  elif [ -f "$VARDO_DIR/.env.prod" ]; then
    warn ".env.prod and .env both exist — using .env"
  fi

  [ -f "$env_file" ] || return

  # HOST_* → VARDO_*
  if grep -q "^HOST_" "$env_file" 2>/dev/null; then
    _sed_i 's/^HOST_DOMAIN=/VARDO_DOMAIN=/' "$env_file"
    _sed_i 's/^HOST_BASE_DOMAIN=/VARDO_BASE_DOMAIN=/' "$env_file"
    _sed_i 's/^HOST_SERVER_IP=/VARDO_SERVER_IP=/' "$env_file"
    _sed_i 's/^HOST_PROJECTS_DIR=/VARDO_PROJECTS_DIR=/' "$env_file"
    _sed_i 's/^HOST_EXPOSE_PORTS=/VARDO_EXPOSE_PORTS=/' "$env_file"
    log "Renamed HOST_* → VARDO_* env vars"
  fi

  # Ensure COMPOSE_PROFILES=production (skip for dev role)
  load_env_display
  if ! is_dev; then
    if ! grep -q "^COMPOSE_PROFILES=.*production" "$env_file" 2>/dev/null; then
      if grep -q "^COMPOSE_PROFILES=" "$env_file"; then
        _sed_i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=production/' "$env_file"
      else
        echo "COMPOSE_PROFILES=production" >> "$env_file"
      fi
      log "Set COMPOSE_PROFILES=production"
    fi
  fi

  # Remove deprecated feature flags
  _sed_i '/^FEATURE_METRICS=/d' "$env_file" 2>/dev/null || true
  _sed_i '/^FEATURE_LOGS=/d' "$env_file" 2>/dev/null || true
}

do_update() {
  [[ "$PLATFORM" != "macos" ]] && check_root

  step "Preflight"

  [ -d "$VARDO_DIR" ] || fail "Vardo not found at $VARDO_DIR. Run 'bash install.sh' to install first."
  [ -f "$VARDO_DIR/$COMPOSE_FILE" ] || fail "No $COMPOSE_FILE in $VARDO_DIR. The installation may be corrupted — try reinstalling."
  [ -f "$VARDO_DIR/.env" ] || fail "No .env in $VARDO_DIR. Run 'bash install.sh' to regenerate configuration."
  command -v docker &>/dev/null || fail "Docker is not installed. Install Docker first: https://docs.docker.com/engine/install/"
  docker compose version &>/dev/null || fail "Docker Compose plugin not found. Install it: https://docs.docker.com/compose/install/"
  [ -d "$VARDO_DIR/.git" ] || fail "$VARDO_DIR is not a git repository. Cannot update without git history."

  cd "$VARDO_DIR"

  local current_version current_branch previous_commit
  current_version=$(get_version)
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  previous_commit=$(git rev-parse HEAD)

  log "Version: $current_version"
  log "Branch: $current_branch"

  # Env migrations
  run_env_migrations

  # Ensure network
  run_cmd docker network create vardo-network 2>/dev/null || true

  # Check for updates
  step "Checking for updates"

  git fetch origin "$current_branch" --quiet 2>/dev/null || git fetch --quiet

  local incoming
  incoming=$(git log HEAD..origin/"$current_branch" --oneline 2>/dev/null || true)

  if [ -z "$incoming" ]; then
    log "Already up to date"
    return
  fi

  local commit_count
  commit_count=$(echo "$incoming" | wc -l | tr -d ' ')
  info "$commit_count incoming commit(s):"
  echo ""
  echo -e "${DIM}"
  git log HEAD..origin/"$current_branch" --oneline --no-decorate | head -20
  echo -e "${RESET}"

  if ! $UNATTENDED && ! $AUTO_YES; then
    if ! confirm "Apply update?"; then
      warn "Update cancelled"
      return
    fi
  fi

  # Backup database
  step "Backup"

  local backup_dir="$VARDO_DIR/backups"
  local backup_file
  backup_file="$backup_dir/pre-update-$(date +%Y%m%d%H%M%S).sql"
  mkdir -p "$backup_dir"

  info "Dumping database..."
  touch "$backup_file" && chmod 600 "$backup_file"
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U host host > "$backup_file" 2>/dev/null; then
    local backup_size
    backup_size=$(du -h "$backup_file" | cut -f1)
    log "Backup: $backup_file ($backup_size)"
  else
    warn "Database backup failed — continuing without backup. Check that the postgres container is running."
    rm -f "$backup_file"
    backup_file=""
  fi

  # Pull
  step "Pulling updates"

  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    warn "Local changes detected, stashing..."
    run_cmd git stash --quiet
  fi

  if run_cmd git pull origin "$current_branch" --quiet; then
    local new_version
    new_version=$(get_version)
    log "Updated: $current_version → $new_version"
  else
    fail "git pull failed — resolve conflicts manually in $VARDO_DIR. Run 'cd $VARDO_DIR && git status' to see what went wrong."
  fi

  # Rebuild
  step "Rebuilding"

  info "Building containers..."
  if $VERBOSE; then
    run_cmd docker compose -f "$COMPOSE_FILE" build
  else
    run_cmd docker compose -f "$COMPOSE_FILE" build --quiet
  fi

  info "Restarting services..."
  run_cmd docker compose -f "$COMPOSE_FILE" up -d

  wait_healthy 90 3

  # Summary
  local new_version
  new_version=$(get_version)
  load_env_display

  echo ""
  echo -e "${GREEN}${BOLD}  Update complete!${RESET}"
  echo ""
  echo -e "  ${BOLD}Dashboard${RESET}   https://${VARDO_DOMAIN:-localhost}"
  echo -e "  ${BOLD}Version${RESET}     $new_version"
  [ -n "${backup_file:-}" ] && echo -e "  ${BOLD}Backup${RESET}      $backup_file"
  echo ""

  dimln "Rollback:"
  dimln "  cd $VARDO_DIR"
  dimln "  git checkout $previous_commit"
  dimln "  docker compose build && docker compose up -d"
  [ -n "${backup_file:-}" ] && dimln "  cat $backup_file | docker compose exec -T postgres psql -U host host"
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════════
# DOCTOR
# ══════════════════════════════════════════════════════════════════════════════

do_doctor() {
  local pass=0 warn_count=0 fail_count=0

  doctor_pass() { log "$1"; pass=$((pass + 1)); }
  doctor_warn() { warn "$1"; warn_count=$((warn_count + 1)); }
  doctor_fail() { echo -e "  ${RED}✗${RESET} $1"; fail_count=$((fail_count + 1)); }

  # ── System ──────────────────────────────────────────────────────────────

  step "System"

  # OS + tier
  if [[ "$PLATFORM" == "macos" ]]; then
    doctor_pass "macOS $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
  elif [[ "$PLATFORM" == "wsl" ]]; then
    doctor_pass "WSL2"
  elif [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    local tier_label=""
    case "$DISTRO_TIER" in
      1) tier_label="tier 1" ;;
      2) tier_label="tier 2" ;;
      3) tier_label="tier 3" ;;
    esac
    if [ "$DISTRO_TIER" -le 2 ]; then
      doctor_pass "$PRETTY_NAME ($tier_label)"
    else
      doctor_warn "$PRETTY_NAME ($tier_label — not officially supported)"
    fi
  else
    doctor_warn "Unknown OS"
  fi

  # Role
  load_env_display
  if [ -n "${VARDO_ROLE:-}" ]; then
    doctor_pass "Role: $VARDO_ROLE"
  fi

  # RAM
  local ram_mb
  ram_mb=$(get_ram_mb)
  if [ "$ram_mb" -ge 2048 ]; then
    doctor_pass "RAM: ${ram_mb}MB"
  elif [ "$ram_mb" -ge 1024 ]; then
    doctor_warn "RAM: ${ram_mb}MB (2GB+ recommended)"
  elif [ "$ram_mb" -gt 0 ]; then
    doctor_fail "RAM: ${ram_mb}MB (minimum 1GB)"
  fi

  # Swap (Linux only — macOS manages its own)
  if [[ "$PLATFORM" != "macos" ]]; then
    if swapon --show 2>/dev/null | grep -q .; then
      local swap_mb
      swap_mb=$(swapon --show --noheadings --raw 2>/dev/null | awk '{sum+=$3} END {printf "%.0f", sum/1024/1024}')
      doctor_pass "Swap: ${swap_mb}MB"
    elif [ "$ram_mb" -lt 4096 ]; then
      doctor_warn "No swap configured (recommended when RAM < 4GB)"
    fi
  fi

  # Disk
  local disk_kb disk_gb
  disk_kb=$(df / 2>/dev/null | tail -1 | awk '{print $4}')
  disk_gb=$((disk_kb / 1048576))
  if [ "$disk_gb" -ge 20 ]; then
    doctor_pass "Disk: ${disk_gb}GB free"
  elif [ "$disk_gb" -ge 10 ]; then
    doctor_warn "Disk: ${disk_gb}GB free (20GB+ recommended)"
  else
    doctor_fail "Disk: ${disk_gb}GB free (critically low — free space immediately)"
  fi

  # ── Installation ────────────────────────────────────────────────────────

  step "Installation"

  if [ -d "$VARDO_DIR" ]; then
    doctor_pass "Directory: $VARDO_DIR"
  else
    doctor_fail "Directory not found: $VARDO_DIR"
    # Can't continue without the installation
    echo ""
    echo -e "  ${BOLD}Result${RESET}  $pass passed, $warn_count warnings, $fail_count failed"
    return
  fi

  if [ -f "$VARDO_DIR/.env" ]; then
    doctor_pass ".env exists"
  else
    doctor_fail ".env not found"
  fi

  if [ -d "$VARDO_DIR/.git" ]; then
    local version branch
    version=$(get_version)
    branch=$(git -C "$VARDO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    doctor_pass "Git: $version ($branch)"

    # Check for available updates
    git -C "$VARDO_DIR" fetch --quiet 2>/dev/null || true
    local behind
    behind=$(git -C "$VARDO_DIR" rev-list HEAD..origin/"$branch" --count 2>/dev/null || echo "0")
    if [ "$behind" -gt 0 ]; then
      doctor_warn "$behind update(s) available"
    else
      doctor_pass "Up to date"
    fi
  else
    doctor_fail "Not a git repository"
  fi

  # ── Docker ──────────────────────────────────────────────────────────────

  step "Docker"

  if command -v docker &>/dev/null; then
    doctor_pass "Docker: $(docker --version 2>/dev/null | sed 's/Docker version //' | cut -d, -f1)"
  else
    doctor_fail "Docker not installed"
    echo ""
    echo -e "  ${BOLD}Result${RESET}  $pass passed, $warn_count warnings, $fail_count failed"
    return
  fi

  if docker compose version &>/dev/null; then
    doctor_pass "Compose: $(docker compose version 2>/dev/null | sed 's/Docker Compose version //')"
  else
    doctor_fail "Docker Compose plugin not found"
  fi

  # Docker daemon
  if docker info > /dev/null 2>&1; then
    doctor_pass "Docker daemon running"
  else
    doctor_fail "Docker daemon not responding"
  fi

  # Log rotation (Linux only)
  if [[ "$PLATFORM" != "macos" ]]; then
    if [ -f /etc/docker/daemon.json ] && grep -q "max-size" /etc/docker/daemon.json 2>/dev/null; then
      doctor_pass "Log rotation configured"
    else
      doctor_warn "Log rotation not configured"
    fi
  fi

  # ── Containers ──────────────────────────────────────────────────────────

  step "Containers"

  if [ -f "$VARDO_DIR/$COMPOSE_FILE" ]; then
    local containers
    containers=$(docker compose -f "$VARDO_DIR/$COMPOSE_FILE" ps --format "{{.Name}}\t{{.Status}}" 2>/dev/null || true)

    if [ -z "$containers" ]; then
      doctor_fail "No containers running"
    else
      while IFS=$'\t' read -r name status; do
        if echo "$status" | grep -qi "healthy"; then
          doctor_pass "$name — healthy"
        elif echo "$status" | grep -qi "up\|running"; then
          doctor_warn "$name — running (no healthcheck)"
        else
          doctor_fail "$name — $status"
        fi
      done <<< "$containers"
    fi
  fi

  # ── Connectivity ────────────────────────────────────────────────────────

  step "Connectivity"

  # PostgreSQL
  if docker compose -f "$VARDO_DIR/$COMPOSE_FILE" exec -T postgres pg_isready -U host -q 2>/dev/null; then
    doctor_pass "PostgreSQL: accepting connections"
  else
    doctor_fail "PostgreSQL: not responding"
  fi

  # Redis
  if docker compose -f "$VARDO_DIR/$COMPOSE_FILE" exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    doctor_pass "Redis: PONG"
  else
    doctor_fail "Redis: not responding"
  fi

  # App health endpoint
  if is_dev; then
    # Dev mode — frontend runs outside compose, check localhost directly
    if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
      doctor_pass "App: /api/health OK (dev server)"
    else
      doctor_warn "App: dev server not running on localhost:3000"
    fi
  else
    if docker compose -f "$VARDO_DIR/$COMPOSE_FILE" exec -T frontend \
      curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
      doctor_pass "App: /api/health OK"
    else
      doctor_fail "App: /api/health unreachable"
    fi
  fi

  # ── DNS ─────────────────────────────────────────────────────────────────

  step "DNS"

  load_env_display
  local server_ip
  server_ip=$(get_server_ip)

  if [ -n "${VARDO_DOMAIN:-}" ] && [ -n "$server_ip" ]; then
    local domain_ip=""
    if command -v dig &>/dev/null; then
      domain_ip=$(dig +short "$VARDO_DOMAIN" 2>/dev/null | head -1)
    elif command -v host &>/dev/null; then
      domain_ip=$(host "$VARDO_DOMAIN" 2>/dev/null | awk '/has address/ {print $4; exit}')
    fi

    if [ -n "$domain_ip" ] && [ "$domain_ip" = "$server_ip" ]; then
      doctor_pass "$VARDO_DOMAIN → $server_ip"
    elif [ -n "$domain_ip" ]; then
      doctor_warn "$VARDO_DOMAIN → $domain_ip (expected $server_ip)"
    else
      doctor_fail "$VARDO_DOMAIN — not resolving"
    fi

    # Wildcard check
    if [ -n "${VARDO_BASE_DOMAIN:-}" ]; then
      local wildcard_ip=""
      if command -v dig &>/dev/null; then
        wildcard_ip=$(dig +short "test-check.$VARDO_BASE_DOMAIN" 2>/dev/null | head -1)
      elif command -v host &>/dev/null; then
        wildcard_ip=$(host "test-check.$VARDO_BASE_DOMAIN" 2>/dev/null | awk '/has address/ {print $4; exit}')
      fi

      if [ -n "$wildcard_ip" ] && [ "$wildcard_ip" = "$server_ip" ]; then
        doctor_pass "*.$VARDO_BASE_DOMAIN → $server_ip"
      elif [ -n "$wildcard_ip" ]; then
        doctor_warn "*.$VARDO_BASE_DOMAIN → $wildcard_ip (expected $server_ip)"
      else
        doctor_fail "*.$VARDO_BASE_DOMAIN — not resolving"
      fi
    fi
  else
    doctor_warn "Cannot check DNS (missing VARDO_DOMAIN or server IP)"
  fi

  # ── TLS ─────────────────────────────────────────────────────────────────

  step "TLS"

  if [ -n "${VARDO_DOMAIN:-}" ]; then
    if curl -sf --max-time 5 "https://${VARDO_DOMAIN}/api/health" > /dev/null 2>&1; then
      doctor_pass "HTTPS: valid certificate for $VARDO_DOMAIN"
    elif curl -sf --max-time 5 -k "https://${VARDO_DOMAIN}/api/health" > /dev/null 2>&1; then
      doctor_warn "HTTPS: responding but certificate may be invalid"
    else
      doctor_fail "HTTPS: not responding on $VARDO_DOMAIN"
    fi
  else
    doctor_warn "Cannot check TLS (VARDO_DOMAIN not set)"
  fi

  # ── Disk usage ──────────────────────────────────────────────────────────

  step "Disk usage"

  local docker_size
  docker_size=$(docker system df --format "{{.Size}}" 2>/dev/null | head -1 || echo "unknown")
  info "Docker images: $docker_size"

  local volume_size
  volume_size=$(docker system df --format "{{.Size}}" 2>/dev/null | tail -1 || echo "unknown")
  info "Docker volumes: $volume_size"

  if [ -d "$VARDO_DIR/backups" ]; then
    local backup_size
    backup_size=$(du -sh "$VARDO_DIR/backups" 2>/dev/null | cut -f1 || echo "0")
    info "Backups: $backup_size"
  fi

  # ── Summary ─────────────────────────────────────────────────────────────

  echo ""
  if [ $fail_count -eq 0 ] && [ $warn_count -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}All clear!${RESET} $pass checks passed"
  elif [ $fail_count -eq 0 ]; then
    echo -e "  ${YELLOW}${BOLD}Mostly healthy${RESET}  $pass passed, $warn_count warning(s)"
  else
    echo -e "  ${RED}${BOLD}Issues found${RESET}  $pass passed, $warn_count warning(s), $fail_count failed"
  fi
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════════
# UNINSTALL
# ══════════════════════════════════════════════════════════════════════════════

do_uninstall() {
  [[ "$PLATFORM" != "macos" ]] && check_root

  step "Uninstall Vardo"

  if [ ! -d "$VARDO_DIR" ]; then
    warn "Vardo not found at $VARDO_DIR"
    return
  fi

  echo ""
  warn "This will stop all Vardo containers."
  if $PURGE; then
    warn "Purge mode: will also remove volumes, data, and installation directory."
  fi
  echo ""

  if ! $UNATTENDED && ! $AUTO_YES; then
    if ! confirm "Stop all Vardo containers?"; then
      warn "Uninstall cancelled"
      return
    fi
  fi

  # Stop containers
  info "Stopping containers..."
  run_cmd docker compose -f "$VARDO_DIR/$COMPOSE_FILE" down 2>/dev/null || true
  log "Containers stopped"

  if $PURGE; then
    # Purge requires explicit interactive confirmation even with --yes
    if $UNATTENDED; then
      # --unattended --purge is allowed (for scripted teardown)
      info "Unattended purge — removing all data"
    elif ! $AUTO_YES; then
      echo ""
      warn "This will permanently delete all Vardo data including the database."
      if ! confirm "Type 'y' to confirm data destruction"; then
        warn "Purge cancelled — containers are stopped, data preserved"
        return
      fi
    fi

    warn "Removing all data in 5 seconds... (Ctrl+C to cancel)"
    sleep 5

    info "Removing Docker volumes..."
    run_cmd docker compose -f "$VARDO_DIR/$COMPOSE_FILE" down -v 2>/dev/null || true
    log "Volumes removed"

    info "Removing $VARDO_DIR..."
    if ! $DRY_RUN; then
      rm -rf "$VARDO_DIR"
    fi
    log "Installation directory removed"

    run_cmd docker network rm vardo-network 2>/dev/null || true
    log "Network removed"

    echo ""
    echo -e "  ${GREEN}${BOLD}Vardo has been completely removed.${RESET}"
  else
    echo ""
    echo -e "  ${GREEN}${BOLD}Vardo containers stopped.${RESET}"
    echo ""
    dimln "Data and configuration preserved at $VARDO_DIR"
    dimln "To remove everything: sudo bash install.sh uninstall --purge"
    dimln "To start again:       docker compose -f $VARDO_DIR/$COMPOSE_FILE up -d"
  fi
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════════
# INTERACTIVE MENU
# ══════════════════════════════════════════════════════════════════════════════

show_menu() {
  local version running
  version=$(get_version)
  running=$(container_count "running")

  load_env_display

  echo -e "  ${BOLD}Vardo${RESET} is installed at $VARDO_DIR"
  echo -e "  Version: ${BOLD}$version${RESET}  |  Containers: ${BOLD}$running running${RESET}"
  echo ""
  echo -e "  ${BOLD}1)${RESET} Update         Pull latest and rebuild"
  echo -e "  ${BOLD}2)${RESET} Doctor         Check system health"
  echo -e "  ${BOLD}3)${RESET} Uninstall      Stop and remove"
  echo -e "  ${BOLD}4)${RESET} Start fresh    Wipe and reinstall"
  echo -e "  ${BOLD}q)${RESET} Quit"
  echo ""

  local choice
  read -rp "  Choose [1]: " choice < /dev/tty
  choice="${choice:-1}"

  case "$choice" in
    1) do_update ;;
    2) do_doctor ;;
    3) do_uninstall ;;
    4)
      echo ""
      warn "This will wipe the current installation and start fresh."
      if confirm "Are you sure?"; then
        # Copy script to temp location since purge deletes /opt/vardo
        local tmp_script
        tmp_script=$(mktemp /tmp/vardo-reinstall.XXXXXX)
        cp "$0" "$tmp_script"
        chmod +x "$tmp_script"
        exec bash "$tmp_script" --fresh-reinstall
      fi
      ;;
    q|Q) exit 0 ;;
    *) warn "Invalid choice"; exit 1 ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      install|update|doctor|uninstall)
        COMMAND="$arg"
        ;;
      --unattended)
        UNATTENDED=true
        ;;
      --yes|-y)
        AUTO_YES=true
        ;;
      --purge)
        PURGE=true
        ;;
      --dry-run)
        DRY_RUN=true
        ;;
      --verbose)
        VERBOSE=true
        ;;
      --help|-h)
        echo "Usage: install.sh [command] [flags]"
        echo ""
        echo "Commands:"
        echo "  install      Fresh installation (default if not installed)"
        echo "  update       Pull latest changes and rebuild"
        echo "  doctor       Run health diagnostics"
        echo "  uninstall    Stop and remove Vardo"
        echo ""
        echo "Flags:"
        echo "  --unattended   Skip all prompts"
        echo "  --yes, -y      Auto-confirm prompts"
        echo "  --purge        Remove all data with uninstall"
        echo "  --dry-run      Show what would be done without making changes"
        echo "  --verbose      Show full command output"
        echo "  --help, -h     Show this help"
        echo ""
        echo "Environment variables (for unattended install):"
        echo "  VARDO_DIR          Installation directory (default: /opt/vardo or ~/vardo on macOS)"
        echo "  VARDO_ROLE         Instance role: production, staging, development"
        echo "  VARDO_DOMAIN       Dashboard domain (production/staging)"
        echo "  VARDO_BASE_DOMAIN  Base domain for projects (production/staging)"
        echo "  ACME_EMAIL         Let's Encrypt email (production)"
        exit 0
        ;;
    esac
  done
}

main() {
  detect_platform
  detect_distro
  parse_args "$@"
  setup_logging
  print_banner

  if $DRY_RUN; then
    info "Dry-run mode — no changes will be made"
  fi
  if $VERBOSE; then
    info "Verbose mode — showing full command output"
  fi

  # Internal flag: "start fresh" copies script to /tmp then exec's with this flag
  if [ "${1:-}" = "--fresh-reinstall" ]; then
    PURGE=true
    AUTO_YES=true
    do_uninstall
    do_install
    # Clean up temp script
    rm -f "$0" 2>/dev/null || true
    return
  fi

  # Explicit command
  if [ -n "$COMMAND" ]; then
    case "$COMMAND" in
      install)   do_install ;;
      update)    do_update ;;
      doctor)    do_doctor ;;
      uninstall) do_uninstall ;;
    esac
    return
  fi

  # Auto-detect: installed → menu, not installed → install
  if is_installed; then
    if $UNATTENDED; then
      # Unattended with no command defaults to update
      do_update
    else
      show_menu
    fi
  else
    do_install
  fi
}

main "$@"
