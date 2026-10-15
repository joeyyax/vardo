# Metrics sources

Vardo reads container metrics from cAdvisor by default. Set one of the variables below in `$VARDO_HOME_DIR/.env` to read them from the collector (`joeyyax/collector`) instead, then restart Vardo. Host metrics still come from `/proc` in the console.

| Variable | Effect |
|---|---|
| `VARDO_COLLECTOR_URL` | Read an existing collector at this URL, such as `http://collector:9273`. Vardo doesn't provision one. Wins over `VARDO_COLLECTOR_IMAGE`. |
| `VARDO_COLLECTOR_TOKEN` or `VARDO_COLLECTOR_TOKEN_FILE` | Bearer token for `VARDO_COLLECTOR_URL`, when that collector sets `api.token_file`. Unset sends none. |
| `VARDO_COLLECTOR_IMAGE` | Provision a collector core service from this image, such as `collector:3d51106`. It gets a generated token, no published port and joins `vardo-monitoring`, where Vardo reads it at `http://collector:9273`. |

With neither `VARDO_COLLECTOR_URL` nor `VARDO_COLLECTOR_IMAGE`, nothing changes.

## Fallback

cAdvisor keeps running as a core service. When the collector is unreachable, stale, rejects the token or hasn't collected twice yet, Vardo reads cAdvisor and retries the collector every minute. The console log says when it switches and when the collector recovers.

GPU readings work the same way: the collector's `nvidia-smi` readings while it answers, the `vardo-gpu-probe` container only while it doesn't. A collector that reports no GPUs means the host has none, so the probe doesn't start.

## What comes from where

- **Collector:** CPU, memory, memory limit, network, disk writes, process count and GPU devices. Live charts update every 15 seconds, the collector's interval.
- **Docker:** the labels outside the collector's allowlist (organization, app id), and which containers were given GPUs.
- **cAdvisor:** per-container filesystem size, only with **Disk metrics** on under Core services.
- **Unchanged:** health state from Docker inspect, per-project disk from `docker system df`.

The collector reports no GPU memory per process, so a GPU shared by several containers is split evenly between them. A `network_mode: host` container shows no network traffic.
