/** Starts a deploy and drains its stream, resolving on success and throwing with the reason on failure. */
export async function runDeploy(orgId: string, appId: string): Promise<void> {
  const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Deploy failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ") && (event === "done" || event === "error")) {
        const data = JSON.parse(line.slice(6));
        if (event === "error") throw new Error(data.message ?? "Deploy failed");
        if (!data.success) throw new Error(data.error ?? "Deploy failed");
        return;
      }
    }
  }
  throw new Error("Deploy stream ended without a result");
}
