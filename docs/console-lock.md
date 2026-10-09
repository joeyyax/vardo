# Console lock

`VARDO_CONSOLE_MIDDLEWARES` in `/opt/vardo/.env` puts Traefik middlewares in front of the console. Unset, the console is open as before.

```
VARDO_CONSOLE_MIDDLEWARES=cloudflare-only@file
VARDO_CONSOLE_CERT_RESOLVER=le-dns
```

The value is a comma-separated list of Traefik middleware references. Apply it with a console deploy, or `docker compose up -d frontend` on an install that isn't self-deployed.

## What the lock covers

| Route | Locked |
| --- | --- |
| `https://<VARDO_DOMAIN>/…` (router `vardo`) | yes |
| The box's IP on ports 80 and 443 (`vardo-fallback`, `vardo-fallback-https`) | yes |
| `https://<VARDO_DOMAIN>/api/health` and `/api/v1/github/webhook` | no |
| `http://<VARDO_DOMAIN>/…` | no; it only redirects to HTTPS |
| Unknown hosts: the "service not found" page and `/_next` assets | no |

The two open paths come from `vardo-console-public@file`, which the console writes to Traefik's dynamic directory at boot while a lock is set and removes when it isn't (`lib/docker/console-lock.ts`). The GitHub webhook checks its own HMAC signature.

## Middlewares

- `cloudflare-only@file`: Vardo maintains it, an ipAllowList of Cloudflare's v4 and v6 ranges refreshed daily from cloudflare.com/ips, plus `VARDO_TRUSTED_PROXIES` (`lib/docker/cloudflare-only.ts`). The console's DNS record must be proxied, or every request gets a 403. Set `VARDO_CONSOLE_CERT_RESOLVER=le-dns` too, since the TLS challenge can't pass Cloudflare's proxy.
- Anything else you define. A Tailscale allowlist, for example:

```
docker exec -i vardo-frontend sh -c 'cat > /etc/traefik/dynamic/tailscale-only.yaml' <<'YAML'
http:
  middlewares:
    tailscale-only:
      ipAllowList:
        sourceRange: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"]
YAML
```

Then `VARDO_CONSOLE_MIDDLEWARES=tailscale-only@file`. Use `.yaml`: an app named `tailscale-only` would replace `tailscale-only.yml`.

## Verify

```
curl -sk -o /dev/null -w '%{http_code}\n' --resolve HOST:443:SERVER_IP https://HOST/            # 403
curl -sk -o /dev/null -w '%{http_code}\n' --resolve HOST:443:SERVER_IP https://HOST/api/health  # 200
curl -sk -o /dev/null -w '%{http_code}\n' https://SERVER_IP/                                    # 403
```

## Gotchas

- A middleware Traefik can't find disables the locked routers: the console's domain shows the "service not found" page and the IP answers 404. It fails closed. Fix the name or clear the variable, then `docker compose up -d frontend` from the slot directory over SSH.

## Trusted proxies

`VARDO_TRUSTED_PROXIES` takes comma-separated IPv4 and IPv6 addresses and CIDRs, such as another Traefik forwarding to this box. Vardo adds them to Traefik's `forwardedHeaders.trustedIPs` beside Cloudflare's ranges, to the `cloudflare-only` allowlist and to the hops whose `CF-Connecting-IP` the console honors. Invalid entries are skipped and logged. A change applies at the next console start, which recreates Traefik once. `VARDO_TRUST_CLOUDFLARE=false` drops Cloudflare's ranges from Traefik's trusted IPs and leaves the allowlist alone.

### Forwarding from another Traefik during a migration (template)

While apps move from an old host to this one, the old host's Traefik can forward each app's host over a private network. Set `VARDO_TRUSTED_PROXIES` here to the old host's private IP first. Then drop one file per app into the old host's dynamic directory (`/etc/dokploy/traefik/dynamic/` on Dokploy). Rollback is deleting the file.

Replace `app.example.com`, `forward-app` and `10.90.0.3` (this box's private IP). `letsencrypt` is Dokploy's resolver name.

```yaml
http:
  routers:
    forward-app:
      rule: Host(`app.example.com`)
      entryPoints: [websecure]
      priority: 100000
      service: forward-app
      tls:
        certResolver: letsencrypt
  services:
    forward-app:
      loadBalancer:
        passHostHeader: true
        serversTransport: forward-app
        servers:
          - url: https://10.90.0.3
  serversTransports:
    forward-app:
      serverName: app.example.com
```

`serverName` sets the SNI this box's Traefik picks the certificate by, and the certificate is verified. If this box doesn't have it yet, use `insecureSkipVerify: true` in place of `serverName`. That's acceptable only because the hop stays on a private network between two hosts you control.

For SMTP submission, add an entrypoint to the old host's static config (`/etc/dokploy/traefik/traefik.yml`), publish 587 on its Traefik container and restart Traefik. Whatever binds 587 there now has to release it first.

```yaml
entryPoints:
  smtp-submission:
    address: ":587"
```

Then a dynamic file:

```yaml
tcp:
  routers:
    forward-smtp:
      rule: HostSNI(`*`)
      entryPoints: [smtp-submission]
      service: forward-smtp
  services:
    forward-smtp:
      loadBalancer:
        servers:
          - address: 10.90.0.3:587
```

`HostSNI(*)` without a `tls` block passes the connection through untouched, which STARTTLS needs. The mail server sees the old host's private IP as the client.
