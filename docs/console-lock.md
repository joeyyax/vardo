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

- `cloudflare-only@file`: Vardo maintains it, an ipAllowList of Cloudflare's v4 and v6 ranges refreshed daily from cloudflare.com/ips (`lib/docker/cloudflare-only.ts`). The console's DNS record must be proxied, or every request gets a 403. Set `VARDO_CONSOLE_CERT_RESOLVER=le-dns` too, since the TLS challenge can't pass Cloudflare's proxy.
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
- Behind Cloudflare, Traefik sees Cloudflare's address, not the visitor's. Traefik doesn't trust Cloudflare's forwarded headers yet, so rate limits key on edge IPs.
