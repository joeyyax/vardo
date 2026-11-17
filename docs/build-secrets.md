# Build secrets

Vardo hands builds a BuildKit secret that a Dockerfile can mount. It never becomes a build arg, so it stays out of image layers, image history, the build key and the deploy log.

| Secret id | Value | When |
| --- | --- | --- |
| `npm_token` | The GitHub App token that cloned the repo | The repo is on github.com and cloned through a linked GitHub App installation |

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

The token must be able to read the packages. GitHub Packages accepts only a personal access token (classic) with `read:packages` or Actions' `GITHUB_TOKEN`, so check that the App's token is accepted before relying on it.

## Behavior

- A Dockerfile that doesn't mount `npm_token` builds exactly as it did. A deploy without a token passes no secret, so only a build that needs it fails.
- The token changes every deploy, but BuildKit keeps secret values out of its cache keys, so layers and image reuse are unaffected.
- A compose file that defines its own top-level secret named `npm_token` keeps its definition.
