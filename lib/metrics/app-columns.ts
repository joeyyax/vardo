/** Columns every stats route selects so an app row can be matched to its containers. */
export const METRICS_APP_COLUMNS = {
  id: true,
  name: true,
  status: true,
  organizationId: true,
  parentAppId: true,
  composeService: true,
  containerName: true,
  importedContainerId: true,
} as const;
