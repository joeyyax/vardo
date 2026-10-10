/** App columns a cron run needs, for `with: { app: CRON_JOB_APP }`. */
export const CRON_JOB_APP = {
  columns: {
    id: true,
    name: true,
    status: true,
    organizationId: true,
    displayName: true,
    parentAppId: true,
    composeService: true,
    containerName: true,
    importedContainerId: true,
  },
  with: { parentApp: { columns: { name: true } } },
} as const;
