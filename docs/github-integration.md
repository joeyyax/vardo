# GitHub integration

Vardo deploys from repos its GitHub App is installed on and reports each deploy back to GitHub through that App.

## Deploy status on GitHub

For an app built from a GitHub App repo, Vardo posts:

- **A preview comment** on each pull request with a preview: one comment per instance, edited in place as the preview goes from queued to building, deploying and live, with a URL per service. A failure shows the reason and a link to the deploy log. A new push resets it, and closing the PR marks it removed.
- **Deployments** for each preview (`preview/pr-<n>/<app>`) and production deploy (`production/<app>`), with queued, in-progress, success, failure and inactive statuses. They add **View deployment** to the PR timeline.
- **Commit statuses** (`vardo/<app>`) on deploys a commit triggered: a push, a relayed push, a poll or a deploy of a pinned SHA.
- **A comment on the merged PR** when production finishes deploying its merge commit: live, failed or rolled back, with the version and duration.

Links to the console appear only when `NEXT_PUBLIC_APP_URL` is a public address.

Calls to GitHub never hold up or fail a deploy. Comment edits are limited to one every five seconds per PR. When GitHub rate-limits an installation, Vardo pauses calls on it until the time GitHub gives, skips in-progress updates and sends the final state once the limit lifts.

With linked instances, only the instance that deploys an app reports on it, and each instance keeps its own comment.

### Turning it off

**Organization settings → General → GitHub** sets the default. Each app overrides it under **Build → Post deploy status to GitHub**.

## Permissions

The GitHub App needs these repository permissions:

| Permission | Access |
| --- | --- |
| Metadata | Read-only |
| Contents | Read-only |
| Pull requests | Read & write |
| Deployments | Read & write |
| Commit statuses | Read & write |

An App created before deploy status existed lacks the last two. Add them on the App's **Permissions & events** page, then approve the change on each installation under **Settings → Integrations → GitHub Apps** of the account that installed it. Until then, GitHub refuses those calls. Vardo turns feedback off for the app, records it once in the app's activity and shows the reason under the setting. Saving the setting retries.

### Permission check

Vardo reads the App's permissions and each linked installation's shortly after it starts, once a day and soon after GitHub refuses a permission. A gap raises one item under **Needs attention**, with a button to the GitHub page that fixes it:

- **The App lacks a permission**: instance admins see it, linked to the App's permissions page.
- **An installation hasn't accepted it yet**: the organizations linked to that installation see it, linked to the installation's page.

Each problem sends one notification through email and the org's other channels, and again only if it changes. Once GitHub reports the permissions granted, the item clears, blocked apps resume posting and the activity log records the approval. **Check again** on the item or under **Admin → Settings → GitHub App** runs the check right away.
