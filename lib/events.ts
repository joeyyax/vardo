type EventMap = {
  "expense:updated": { expenseId: string };
  "expense:deleted": { expenseId: string };
  "expense:comment:created": { expenseId: string };
  "expense:comment:updated": { expenseId: string; commentId: string };
  "expense:comment:deleted": { expenseId: string; commentId: string };
  "project:comment:created": { projectId: string };
  "project:comment:updated": { projectId: string; commentId: string };
  "project:comment:deleted": { projectId: string; commentId: string };
  "client:comment:created": { clientId: string };
  "client:comment:updated": { clientId: string; commentId: string };
  "client:comment:deleted": { clientId: string; commentId: string };
  "invoice:updated": { invoiceId: string };
  "invoice:deleted": { invoiceId: string };
  "invoice:comment:created": { invoiceId: string };
  "invoice:comment:updated": { invoiceId: string; commentId: string };
  "invoice:comment:deleted": { invoiceId: string; commentId: string };
  "document:comment:created": { documentId: string };
  "document:comment:updated": { documentId: string; commentId: string };
  "document:comment:deleted": { documentId: string; commentId: string };
  "contact:comment:created": { contactId: string };
  "contact:comment:updated": { contactId: string; commentId: string };
  "contact:comment:deleted": { contactId: string; commentId: string };
  "document:status:changed": { documentId: string; projectId: string; newStatus: string };
  "project:stage:changed": { projectId: string; newStage: string };
};

type EventName = keyof EventMap;
type EventHandler<T extends EventName> = (payload: EventMap[T]) => void;

const listeners = new Map<EventName, Set<EventHandler<EventName>>>();

function on<T extends EventName>(event: T, handler: EventHandler<T>) {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)!.add(handler as EventHandler<EventName>);

  return () => {
    listeners.get(event)?.delete(handler as EventHandler<EventName>);
  };
}

function emit<T extends EventName>(event: T, payload: EventMap[T]) {
  listeners.get(event)?.forEach((handler) => handler(payload));
}

export const eventBus = { on, emit };
