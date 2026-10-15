# Metrics sources

Vardo reads container metrics from the collector (`joeyyax/collector`), with cAdvisor as the fallback. Set the variables below in `$VARDO_HOME_DIR/.env` and restart Vardo to change that. Host metrics still come from `/proc` in the console.

| Variable | Effect |
|---|---|
| `VARDO_COLLECTOR_URL` | Read an existing collector at this URL, such as `http://collector:9273`. Vardo doesn't provision one. Wins over `VARDO_COLLECTOR_IMAGE`. |
| `VARDO_COLLECTOR_TOKEN` or `VARDO_COLLECTOR_TOKEN_FILE` | Bearer token for `VARDO_COLLECTOR_URL`, when that collector sets `api.token_file`. Unset sends none. |
| `VARDO_COLLECTOR_IMAGE` | The image Vardo provisions its collector core service from. Unset means `ghcr.io/joeyyax/collector:0.2.0`; `off` reads cAdvisor only. The collector gets a generated token, no published port and joins `vardo-monitoring`, where Vardo reads it at `http://collector:9273`. |

## Fallback

cAdvisor keeps running as a core service. When the collector is unreachable, stale, rejects the token or hasn't collected twice yet, Vardo reads cAdvisor and retries the collector every minute. The console log says when it switches and when the collector recovers.

GPU readings work the same way: the collector's `nvidia-smi` readings while it answers, the `vardo-gpu-probe` container only while it doesn't. A collector that reports no GPUs means the host has none, so the probe doesn't start.

## What comes from where

- **Collector:** one `/api/v1/containers` call per poll for CPU, memory, memory limit, network, disk writes, process count, labels (organization and app id through `containers.api_labels`) and per-container GPU memory. Staleness is judged against the collector's `interval_seconds`, and live charts update at that interval (15 seconds as provisioned). GPU readings add one `/api/v1/host` call for the devices.
- **Docker:** nothing per poll on collector 0.2.0. A collector without `api_labels`, such as 0.1.0, gets one inspect per new container for the organization and app id, and the GPU even split below inspects each new container for its GPUs.
- **Docker, with Disk metrics on:** each container's writable-layer size, measured at most hourly and one container at a time, because measuring walks the layer. The stats API gives each size's `diskMeasuredAt`. With Disk metrics off, Vardo never asks for sizes, and in collector mode cAdvisor skips its disk walk either way.
- **Unchanged:** health state from Docker inspect, per-project disk from `docker system df`.

## GPUs

On a host with an NVIDIA runtime, Vardo runs its collector with `pid: host`, which `nvidia-smi` needs to see other containers' processes. Each container then reports the GPU memory it holds, and a device's utilization is split by those shares. A container holding no GPU memory shows no GPU reading. Hosts without a GPU never get `pid: host`.

A collector that reports devices but no per-container memory (before 0.2.0, or run without `pid: host`) gets the old even split: each GPU's memory and utilization divided between the containers given it.

A `network_mode: host` container shows no network traffic.
