# Deploy variables

Vardo sets these in every container of every app and preview. They're read-only and listed under **Set by Vardo** on the app's Variables tab.

| Variable | Value | Build |
| --- | --- | --- |
| `VARDO_GIT_SHA` | The deployed commit, 40 characters | Yes |
| `VARDO_GIT_BRANCH` | The branch it came from | Yes |
| `VARDO_DEPLOY_ID` | The deployment's ID | No |
| `VARDO_DEPLOYED_AT` | When the deploy wrote the containers' config, ISO 8601 UTC | No |
| `VARDO_APP_NAME` | The app's name; a compose service's own app name when it has one | No |
| `VARDO_APP_URL` | The primary domain, `https://` unless TLS is off, with its path prefix | No |
| `VARDO_ENVIRONMENT` | The environment's name: `production`, or a preview's name | No |
| `VARDO_MEMORY_LIMIT` | The memory limit applied, in bytes, including a learned or tier default | No |
| `VARDO_SLOT` | `blue` or `green` | No |

A variable without a value is left out:

- An app with no git repo (image or compose content) gets no `VARDO_GIT_SHA` or `VARDO_GIT_BRANCH`.
- An app with no domain gets no `VARDO_APP_URL`.
- An app with its memory limit set to 0 (no cap) gets no `VARDO_MEMORY_LIMIT`.
- A local environment gets no `VARDO_SLOT`.

## Precedence

A variable of the same name in the app's own variables, or in a compose service's `environment:`, wins. Vardo doesn't set its value.

## Compose apps

Each service gets them. A service with its own child app gets that app's name and primary domain. One without a domain of its own gets the app's.

Shared services (`x-vardo-shared`) get none: a value that changes every deploy would recreate them every deploy.

## Rollbacks and restarts

The values live in each slot's `docker-compose.override.yml`.

- **Rollback** is a new deploy of the target's commit: the target's `VARDO_GIT_SHA` and branch, with the rollback's own `VARDO_DEPLOY_ID` and `VARDO_DEPLOYED_AT`.
- **Instant rollback** starts the standby slot as it was: every value is the deploy that built that slot.
- **Restart** and **recreate** keep the slot's values.

They aren't part of the encrypted env snapshot, so restoring env vars on a rollback never turns them into app variables.

## Build time

Builds get only `VARDO_GIT_SHA` and `VARDO_GIT_BRANCH`, unless the app's variables set them:

- **Dockerfile** and **compose** builds: as build args. Declare `ARG VARDO_GIT_SHA` to use one; undeclared, it changes nothing and stays out of the build key.
- **Railpack** and **Nixpacks**: as build env, like the app's variables. Both are in the build key.

The other variables change every deploy, so they never reach a build and never bust the cache or image reuse. See [Build cache](build-cache.md).
