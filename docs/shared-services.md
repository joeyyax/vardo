# Shared services

A compose service marked `x-vardo-shared: true` doesn't rotate with blue/green. It runs once, in the project `<app>-<env>-shared` (or the compose file's top-level `name`), and a deploy leaves it running. Use it for a service that can't run twice: one that publishes a host port, holds a lock or owns a data directory.

A deploy recreates a shared service only when its definition changes. It compares the running container's `com.docker.compose.config-hash` label with `docker compose config --hash`, which hashes the interpolated definition. Data stores are held instead and the deploy logs the command to apply the change. Vardo keeps its per-deploy labels off shared services, so a deploy that changes nothing else leaves them alone.

## Commit variables

Vardo sets two variables for compose interpolation in every slot. Containers don't see them unless the compose file passes them in.

| Variable | Value |
| --- | --- |
| `VARDO_GIT_SHA` | The deployed commit, 40 characters |
| `VARDO_GIT_SHORT_SHA` | Its first 7 characters |

An app with no git repo gets `local` for both. A rollback gets the commit it rolls back to. Each slot keeps its own values in `.vardo.env`, so stopping, restarting or rolling back a slot interpolates the commit that slot was deployed with.

## A shared service that runs the app's own build

A shared service that reuses an image the rotating service builds never picks up new code if the tag stays the same: its definition doesn't change, so the deploy doesn't recreate it. Tag the image with the commit instead.

```yaml
services:
  web:
    build: .
    image: myapp:${VARDO_GIT_SHORT_SHA}

  smtp:
    image: myapp:${VARDO_GIT_SHORT_SHA}
    pull_policy: never
    command: ["node", "smtp.js"]
    ports:
      - "587:587"
    x-vardo-shared: true
```

Each release changes `smtp`'s definition, so the deploy builds `web`, then recreates `smtp` on the new image. A failed recreate puts `smtp` back on the previous slot's definition, which still names the previous commit's image. `pull_policy: never` stops the deploy from looking for the tag in a registry.

Without a git repo the tag stays `local` and this falls back to a fixed tag.

## Reaching other apps in the project

Apps in one project reach each other by compose service name. Each deploy attaches every service to the network `vardo-p-<project id>-<environment>`, alongside the app's own network and, for routed services, `vardo-network`. An untrusted organization needs no trust for this.

A Railpack, Nixpacks, Dockerfile or image app's service is named after the app. With a `shop-db` compose app running `postgres` and a `shop-east` Railpack app in the same project:

```
DATABASE_URL=postgres://app:secret@postgres:5432/shop
```

- Production and each preview environment get their own network, so `pr-7` never reaches production's database.
- A shared service joins in place, so a held data store answers from both slots without a recreate. During a deploy both slots of a rotating service answer to its name.
- When another app in the project already has a service by the same name, the deploy leaves the new app off the network and logs which name collides. Rename the service in one of the apps.
- A compose file can't set aliases on the project network or join another project's.
- Deleting a project's last app removes its networks.
