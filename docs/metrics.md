# Metrics sources

Vardo reads container and GPU metrics from the collector (`joeyyax/collector`). Set the variables below in `$VARDO_HOME_DIR/.env` and restart Vardo to change where it reads them. Host metrics still come from `/proc` in the console.

| Variable | Effect |
|---|---|
| `VARDO_COLLECTOR_URL` | Read an existing collector at this URL, such as `http://collector:9273`. Vardo doesn't provision one. Wins over `VARDO_COLLECTOR_IMAGE`. |
| `VARDO_COLLECTOR_TOKEN` or `VARDO_COLLECTOR_TOKEN_FILE` | Bearer token for `VARDO_COLLECTOR_URL`, when that collector sets `api.token_file`. Unset sends none. |
| `VARDO_COLLECTOR_IMAGE` | The image Vardo provisions its collector core service from. Unset means `ghcr.io/joeyyax/collector:0.3.1`. The collector gets a generated token, no published port and joins `vardo-monitoring`, where Vardo reads it at `http://collector:9273`. `off` means no container or GPU metrics, so no disk-write alerts either; disk usage from `docker system df` and business metrics keep running. |

## When the collector is down

There's no fallback. Container metrics pause and the metrics loop keeps retrying, at most 2 minutes apart. After three failed health checks, the Collector service raises a "Container metrics are paused" alert, which resolves when it answers again. A collector that hasn't collected twice yet, right after it starts, skips the tick instead of counting as a failure.

## What comes from where

- **Collector:** one `/api/v1/containers` call per poll for CPU, memory, memory limit, network, disk writes, process count, labels (organization and app id through `containers.api_labels`) and per-container GPU memory. Staleness is judged against the collector's `interval_seconds`, and live charts update at that interval (15 seconds as provisioned). GPU readings add one `/api/v1/host` call for the devices.
- **Docker:** nothing per poll on collector 0.2.0. A collector without `api_labels`, such as 0.1.0, gets one inspect per new container for the organization and app id, and the GPU even split below inspects each new container for its GPUs.
- **Docker, with Disk metrics on:** each container's writable-layer size, measured at most hourly and one container at a time, because measuring walks the layer. The stats API gives each size's `diskMeasuredAt`. With Disk metrics off, Vardo never asks for sizes. The switch is under Admin → Built-in services.
- **Unchanged:** health state from Docker inspect, per-project disk from `docker system df`.

## GPUs

GPU readings come only from the collector. On a host with an NVIDIA runtime, Vardo runs its collector with `pid: host`, which `nvidia-smi` needs to see other containers' processes. Each container then reports the GPU memory it holds, and a device's utilization is split by those shares. A container holding no GPU memory shows no GPU reading. Hosts without a GPU never get `pid: host`.

A collector that reports devices but no per-container memory (before 0.2.0, or run without `pid: host`) gets an even split: each GPU's memory and utilization divided between the containers given it.

A `network_mode: host` container shows no network traffic.

## Upgrading from cAdvisor

Earlier releases ran cAdvisor next to the collector. Vardo removes that install on its own, about 10 minutes after boot and then hourly. With metrics on and a collector configured, it waits until the collector has served metrics and a direct read of it succeeds. Until then, Admin → Built-in services lists cAdvisor as Retiring and says why. With metrics off or `VARDO_COLLECTOR_IMAGE=off`, nothing reads cAdvisor, so it's removed without waiting.
