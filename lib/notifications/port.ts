export type NotificationEventType = "deploy-success" | "deploy-failed" | "backup-success" | "backup-failed" | "cron-failed";
export type NotificationEvent = { type: NotificationEventType; title: string; message: string; metadata: Record<string, string> };
export interface NotificationChannel { send(event: NotificationEvent): Promise<void>; }
