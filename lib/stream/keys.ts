/** Org-scoped event stream. */
export const eventStream = (orgId: string) => `stream:events:${orgId}`;

export const deployStream = (deployId: string) => `stream:deploy:${deployId}`;

export const toastStream = (userId: string) => `stream:toasts:${userId}`;

/** Per-install progress stream. */
export const installStream = (installId: string) => `stream:install:${installId}`;
