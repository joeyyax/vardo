// ---------------------------------------------------------------------------
// Stream key naming conventions
// ---------------------------------------------------------------------------

/** Org-scoped event stream (notifications, deploy status, backup status, etc.) */
export const eventStream = (orgId: string) => `stream:events:${orgId}`;

/** Per-deploy log stream */
export const deployStream = (deployId: string) => `stream:deploy:${deployId}`;

/** Per-user toast stream */
export const toastStream = (userId: string) => `stream:toasts:${userId}`;

/** Per-install progress stream (integration installs, one-off workflows) */
export const installStream = (installId: string) => `stream:install:${installId}`;
