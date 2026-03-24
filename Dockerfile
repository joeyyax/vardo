FROM node:22-alpine AS base
RUN corepack enable

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json ./apps/console/
COPY apps/www/package.json ./apps/www/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/console/node_modules ./apps/console/node_modules
COPY . .

ARG NEXT_PUBLIC_BETTER_AUTH_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ARG NEXT_PUBLIC_PLAUSIBLE_SRC
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_PLAUSIBLE_DOMAIN=$NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ENV NEXT_PUBLIC_PLAUSIBLE_SRC=$NEXT_PUBLIC_PLAUSIBLE_SRC

RUN pnpm --filter vardo-console build

# Production — standalone output, no node_modules needed
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user for the Node process.
# The docker group (GID 999) matches the conventional Docker socket GID on
# Debian/Ubuntu hosts so the process can communicate with the mounted socket
# without running as root. If the host's docker group uses a different GID,
# override at runtime with: --group-add <host-docker-gid>
RUN addgroup --system --gid 1001 nodejs && \
    addgroup --system --gid 999 docker && \
    adduser --system --uid 1001 --ingroup nodejs nextjs && \
    adduser nextjs docker && \
    mkdir -p /var/lib/host/projects && \
    chown nextjs:nodejs /var/lib/host/projects

# Copy standalone output (includes only needed node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/apps/console/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/console/public ./apps/console/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/console/drizzle ./apps/console/drizzle
COPY --from=builder --chown=nextjs:nodejs /app/apps/console/scripts/migrate.mjs ./apps/console/scripts/migrate.mjs

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["sh", "-c", "node apps/console/scripts/migrate.mjs && node apps/console/server.js"]
