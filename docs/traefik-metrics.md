# Traefik metrics

Traefik serves Prometheus metrics on a dedicated entrypoint, off by default.

Set `VARDO_TRAEFIK_METRICS=true` in the `.env` beside `docker-compose.yml`, then recreate Traefik:

```bash
docker compose up -d --no-deps traefik
```

The scrape target is `vardo-traefik:8082` on `vardo-network`, path `/metrics`. The port isn't published and no router uses the `metrics` entrypoint, so nothing outside the Docker network reaches it. Any container on `vardo-network` can, so enable it only where every app there is trusted. Vardo refuses untrusted apps that route on the `metrics` entrypoint.

A scrape job for an Observability stack on `vardo-network`:

```yaml
scrape_configs:
  - job_name: traefik
    static_configs:
      - targets: ["vardo-traefik:8082"]
```

The trusted-proxies sync recreates Traefik from the same compose file and `.env`, so the setting survives it.
