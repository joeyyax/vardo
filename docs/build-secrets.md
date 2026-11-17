# Build secrets

Vardo hands builds a BuildKit secret that a Dockerfile can mount. It never becomes a build arg, so it stays out of image layers, image history, the build key and the deploy log.

| Secret id | Value | When |
| --- | --- | --- |
| `npm_token` | A `contents: read` token from the GitHub App installation that cloned the repo, valid for at least 40 minutes | The repo is on github.com and cloned through a linked GitHub App installation |
| Any org secret | What an org admin set | Always |

An org secret beats the GitHub App token of the same id. An org `npm_token` holding a classic token with `read:packages` replaces the App token on every build in the org. Delete it and builds fall back to the App token.

Dockerfile apps and git-sourced compose apps get it on every service they build. Railpack and Nixpacks builds don't.

## Installing private npm packages

Commit an `.npmrc` that reads the token from the environment:

```ini
@joeyyax:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Mount the secret as `NODE_AUTH_TOKEN` on the install step only:

```dockerfile
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN pnpm install --frozen-lockfile
```

The `env=` form needs Dockerfile syntax 1.10 or newer, which Vardo's BuildKit (v0.34) ships. On an older Docker daemon, add `# syntax=docker/dockerfile:1` as the first line, or read the file form instead:

```dockerfile
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" pnpm install --frozen-lockfile
```

The token must be able to read the packages. GitHub Packages accepts only a personal access token (classic) with `read:packages` or Actions' `GITHUB_TOKEN`, so set an org `npm_token` unless the App's token is accepted.

## Org build secrets

Owners and admins set them. Values are encrypted at rest and write-only: nothing returns them, and the activity log records only "set build secret npm_token". They apply from the next deploy.

- **Console:** **Organization settings → Variables → Build secrets**.
- **API:** `PUT /api/v1/organizations/{orgId}/build-secrets/{name}` with `{"value": "..."}`, `DELETE` on the same path and `GET /api/v1/organizations/{orgId}/build-secrets` for names.
- **MCP:** `vardo_set_build_secret` (omit `value` to delete) and `vardo_list_build_secrets`.

A name is lowercase letters, digits and underscores, starting with a letter. The deploy log names each secret and its source, such as `npm_token (org secret)`.

## Behavior

- A Dockerfile that doesn't mount `npm_token` builds exactly as it did. A deploy without a token passes no secret, so only a build that needs it fails.
- The token changes every deploy, but BuildKit keeps secret values out of its cache keys, so layers and image reuse are unaffected.
- A compose file that defines its own top-level secret named `npm_token` keeps its definition.
