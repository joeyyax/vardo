// What Deploy all says once the project's deploys are queued.

/** The count in the `queued` event that opens a group deploy's stream, or null without one. Stops reading there. */
export async function queuedCount(res: Response): Promise<number | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event !== "queued" || !data) continue;
        const { count } = JSON.parse(data) as { count?: unknown };
        return typeof count === "number" ? count : null;
      }
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** "Queued 3 deploys", or the project's name when the count didn't arrive. */
export function queuedDeploysText(count: number | null, project: string): string {
  if (count === null) return `Queued a deploy of every app in ${project}`;
  return `Queued ${count} ${count === 1 ? "deploy" : "deploys"}`;
}
