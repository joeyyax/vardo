# Domains & TLS Guide

Vardo uses Traefik as a reverse proxy for all HTTP traffic. Traefik discovers containers via Docker labels and handles TLS certificate provisioning automatically through Let's Encrypt.

## How it works

```
Internet → Traefik (:80, :443)
             ├── vardo-network (Docker)
             │     ├── app-blue containers (Traefik labels)
             │     └── app-green containers (Traefik labels)
             └── Let's Encrypt (ACME) → TLS certs
```

When you add a domain to an app, Vardo injects Traefik labels into the compose file at deploy time. Traefik reads these labels from running containers on the `vardo-network` Docker network and starts routing traffic — no config reload needed.

## Adding a custom domain

1. Go to your app → **Domains** → **Add Domain**.
2. Enter the domain (e.g. `app.example.com`).
3. Configure DNS (see below).
4. Deploy the app. Traefik will request a TLS certificate automatically.

Each domain is associated with one app and one container port. Multiple domains can point to the same app.

### Domain fields

| Field | Description |
|---|---|
| `domain` | Fully qualified domain name |
| `port` | Container port for this domain (overrides app default) |
| `certResolver` | Certificate resolver to use (default: `le`) |
| `sslEnabled` | Enable HTTPS (default: true) |
| `isPrimary` | Mark as the primary domain (used for `${project.domain}`) |
| `serviceName` | Target a specific service in a multi-service compose file |

## DNS configuration

For a domain like `app.example.com`:

**A record** (recommended for root domains):
```
app.example.com.  A  <your-server-ip>
```

**CNAME record** (for subdomains):
```
app.example.com.  CNAME  your-vardo-host.example.com.
```

DNS changes typically propagate in minutes, but can take up to 48 hours. Traefik will not issue a certificate until DNS resolves to the server.

### Wildcard domains

Wildcard domains (e.g. `*.example.com`) require a DNS challenge for certificate issuance. Traefik supports DNS challenges via supported providers. Configure the DNS provider credentials in your Traefik configuration.

> **Note:** Wildcard certificate support via DNS challenge requires additional Traefik configuration not managed by Vardo directly. Set this up in your Traefik config files.

## Automatic TLS via Let's Encrypt

When `sslEnabled: true` (the default), Vardo injects these Traefik labels:

```yaml
traefik.http.routers.{routerName}.entrypoints: websecure
traefik.http.routers.{routerName}.tls: "true"
traefik.http.routers.{routerName}.tls.certresolver: le
# HTTP → HTTPS redirect
traefik.http.routers.{routerName}-http.entrypoints: web
traefik.http.routers.{routerName}-http.middlewares: {routerName}-https-redirect
traefik.http.middlewares.{routerName}-https-redirect.redirectscheme.scheme: https
traefik.http.middlewares.{routerName}-https-redirect.redirectscheme.permanent: "true"
```

Traefik requests a certificate from Let's Encrypt using the HTTP-01 challenge on port 80. The certificate is stored in Traefik's ACME storage and renewed automatically before expiry.

### Certificate resolvers

The `certResolver` field on a domain maps to a named resolver in your Traefik configuration. The default is `le` (Let's Encrypt production). You can configure additional resolvers in Traefik (e.g. `le-staging` for the staging CA, `google` for Google's CA, `zerossl` for ZeroSSL) and reference them by name.

> **Note:** Configuring additional ACME issuers is done in your Traefik config. Vardo passes the resolver name through to the label — it does not manage Traefik's resolver configuration.

### Multiple ACME certificate issuers

> **Planned** — Tracked in [#323](https://github.com/joeyyax/vardo/issues/323)

Vardo will support configuring multiple ACME certificate issuers — Let's Encrypt, Google's public CA, and ZeroSSL — with automatic fallback. If the primary issuer fails (rate limits, outage), Vardo will automatically retry with the next issuer in the configured priority list.

When implemented, you will be able to configure the issuer list in `vardo.yml` and select a per-domain preferred issuer from the domain settings UI. The fallback chain removes the current manual workaround of configuring Traefik resolvers directly.

### HTTP-only

To disable TLS for a domain, set `sslEnabled: false`. Vardo will route the domain on the `web` entrypoint without TLS or redirect.

## `.localhost` domains for development

Domains ending in `.localhost` are treated specially:

- TLS is configured (`tls: true`) but no cert resolver is set.
- Traefik generates a self-signed certificate automatically.
- No DNS configuration needed — `*.localhost` resolves to `127.0.0.1` on most systems.

Example: `myapp.localhost` works out of the box for local development.

## Auto-generated subdomains

When you create an app, Vardo optionally generates a subdomain automatically:

- **App subdomain**: `{appName}-{adjective}-{noun}.{baseDomain}` (e.g. `myapp-spicy-mango.example.com`)
- **Environment subdomain**: `{appName}-{envName}.{baseDomain}` (e.g. `myapp-staging.example.com`)
- **Preview subdomain**: `{appName}-pr-{prNumber}.{baseDomain}` (e.g. `myapp-pr-42.example.com`)

The base domain is configured per-organization (`org.baseDomain`), with a fallback to `VARDO_BASE_DOMAIN` from the environment.

## Domain monitoring

Vardo monitors all domains attached to active apps every 5 minutes. The monitor:

1. Fetches all domains attached to apps with `status: active`.
2. Probes each domain via HTTPS, following redirects (10-second timeout).
3. Falls back to HTTP if HTTPS fails.
4. Records a `domain_check` entry with: reachable status, HTTP status code, response time.
5. Keeps the last 100 checks per domain (older entries are pruned).

A domain is considered reachable if the HTTP status code is < 500.

### State transition alerts

The monitor detects when a domain transitions from reachable to unreachable. When this happens, it logs a warning:

```
[domain-monitor] WARNING: app.example.com (app: myapp) is unreachable — connect ECONNREFUSED
```

### Checking domain health

The `domain_check` table stores the monitoring history. In the UI, each domain shows its last check status and response time. The API exposes check history per domain.

## Traefik network

All Vardo-managed containers attach to the `vardo-network` Docker bridge network. Traefik must be on this network to discover containers.

The network is declared as external in compose files:

```yaml
networks:
  vardo-network:
    external: true
```

Vardo creates the network if it doesn't exist during deploy.

## Cloudflare configuration (recommended)

If you're using Cloudflare as your DNS provider, the recommended setup:

**DNS settings:**
- Set DNS records to **DNS only** (grey cloud), not proxied, while initially setting up TLS. Once the Let's Encrypt certificate is issued and working, you can switch to proxied if desired.
- For **Full (Strict) SSL mode**: Cloudflare requires a valid certificate on the origin server. Let's Encrypt certificates satisfy this.

**SSL/TLS settings:**
- Mode: **Full (Strict)** — encrypts traffic end-to-end with validation
- Always use HTTPS: enabled
- Automatic HTTPS Rewrites: enabled

**Security settings:**
- Enable WAF with OWASP rules for basic protection
- Rate limiting rules to prevent abuse
- Bot Management or Bot Fight Mode to reduce automated traffic

**Important:** If you use Cloudflare's proxy (orange cloud), the IP that Traefik/Let's Encrypt sees is a Cloudflare IP, not the client. HTTP-01 ACME challenges still work with Cloudflare proxy enabled, but ensure port 80 is accessible from Cloudflare's servers.

## Troubleshooting

### Certificate not issued

- DNS has not propagated yet. Check with `dig app.example.com` — it must return your server's IP.
- Port 80 is blocked by a firewall. Let's Encrypt requires HTTP access on port 80 for the HTTP-01 challenge.
- Let's Encrypt rate limits. The production CA allows 5 certificates per domain per week. Use the staging resolver (`le-staging`) while testing.
- The domain doesn't resolve at all. Verify DNS records are correct.

### 404 or no route found

- The app is not deployed. Check the app's deployment status.
- The domain was added after the last deploy. Redeploy the app to inject updated Traefik labels.
- The container is not on `vardo-network`. This can happen if the network was created after the container started — redeploy.

### SSL certificate warning in browser

- For `.localhost` domains: expected — Traefik uses a self-signed cert.
- For production domains: the cert may not have been issued yet (DNS propagation) or Traefik's ACME storage may be missing/corrupted.

### Domain shows as unreachable in monitoring

- Check that the app container is running (`docker ps`).
- Check that the domain resolves to the correct server (`dig app.example.com`).
- Check Traefik logs for routing errors.
- If using Cloudflare proxy: the monitor probes from the Vardo server. If Vardo is behind Cloudflare, there may be a routing loop. Use an unproxied DNS record for monitoring, or configure the monitor to use the internal hostname.

## API

```
GET    /api/v1/organizations/{orgId}/domains
POST   /api/v1/organizations/{orgId}/apps/{appId}/domains
GET    /api/v1/organizations/{orgId}/apps/{appId}/domains
PUT    /api/v1/organizations/{orgId}/apps/{appId}/domains/{domainId}
DELETE /api/v1/organizations/{orgId}/apps/{appId}/domains/{domainId}
```
