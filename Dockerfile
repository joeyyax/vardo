FROM node:22-slim AS base
RUN corepack enable

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_BETTER_AUTH_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ARG NEXT_PUBLIC_PLAUSIBLE_SRC
ARG GIT_SHA
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_PLAUSIBLE_DOMAIN=$NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ENV NEXT_PUBLIC_PLAUSIBLE_SRC=$NEXT_PUBLIC_PLAUSIBLE_SRC
ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA

RUN pnpm build

# Production
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Runtime dependencies — git for cloning, docker-cli for orchestrating builds/deploys
# Install Docker CLI from official Docker repo (docker.io from apt is too old for modern daemons)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends git curl ca-certificates gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends docker-ce-cli iproute2 gosu && \
    curl -sSL https://nixpacks.com/install.sh | bash && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then RAILPACK_ARCH="arm64"; else RAILPACK_ARCH="x86_64"; fi && \
    RAILPACK_VERSION=$(curl -sSL https://api.github.com/repos/railwayapp/railpack/releases/latest | grep '"tag_name"' | cut -d'"' -f4) && \
    curl -sSL "https://github.com/railwayapp/railpack/releases/download/${RAILPACK_VERSION}/railpack-${RAILPACK_VERSION}-${RAILPACK_ARCH}-unknown-linux-musl.tar.gz" \
      | tar xz -C /usr/local/bin railpack && \
    chmod +x /usr/local/bin/railpack && \
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --create-home nextjs && \
    mkdir -p /var/lib/vardo/projects && \
    chown nextjs:nodejs /var/lib/vardo/projects

# Copy built app + all dependencies
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/templates ./templates
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

COPY --chown=nextjs:nodejs scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Entrypoint runs as root to set up mesh routing, then drops to nextjs for the app.
# NET_ADMIN capability is required in docker-compose for the ip route command.
ENTRYPOINT ["./scripts/entrypoint.sh"]
