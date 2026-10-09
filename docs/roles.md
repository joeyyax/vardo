# Roles

Each org member holds one role. The source of truth is `CAPABILITIES` in `lib/auth/permissions.ts`; every org route and MCP tool checks it.

Members do the day-to-day work: deploy, restart, stop, edit config and env vars, run backups. Anything that can't be undone, hands out plaintext secrets or opens a shell needs an admin.

| Action | Owner | Admin | Member | Viewer |
| --- | --- | --- | --- | --- |
| View the org, projects and apps | ✓ | ✓ | ✓ | ✓ |
| Create and configure projects and apps, domains, tags | ✓ | ✓ | ✓ | |
| Deploy, restart, stop, recreate, roll back | ✓ | ✓ | ✓ | |
| Manage cron jobs | ✓ | ✓ | ✓ | |
| Read env vars, masked | ✓ | ✓ | ✓ | |
| Write env vars | ✓ | ✓ | ✓ | |
| Reveal plaintext env vars (app, org, MCP) | ✓ | ✓ | | |
| Open a container terminal | ✓ | ✓ | | |
| View backups and run one now | ✓ | ✓ | ✓ | |
| Restore, download or delete backups; manage targets and jobs | ✓ | ✓ | | |
| Sync volume files | ✓ | ✓ | | |
| Delete apps, previews and projects | ✓ | ✓ | | |
| GPU, app certificates, debug output | ✓ | ✓ | | |
| Org settings, members, invitations, digest, transfers | ✓ | ✓ | | |
| Notifications, API tokens, deploy keys | ✓ | ✓ | ✓ | |
| Delete the org or transfer ownership | ✓ | | | |

Viewer is in the capability map but can't be assigned yet.

An instance admin also holds every backup capability in any org they belong to. Container import, `allowDockerSocket`, `allowBindMounts` and `trusted` are instance-admin only, whatever the org role.

Terminal sessions and every reveal are recorded in the activity log (`app.terminal_opened`, `app.env_revealed`, `org.env_revealed`).

A member saving env vars sends the masked values back; the server keeps the stored value for any value still masked.
