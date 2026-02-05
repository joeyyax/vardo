type EventMap = {
  "expense:updated": { expenseId: string };
  "expense:deleted": { expenseId: string };
  "expense:comment:created": { expenseId: string };
  "expense:comment:updated": { expenseId: string; commentId: string };
  "expense:comment:deleted": { expenseId: string; commentId: string };
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
