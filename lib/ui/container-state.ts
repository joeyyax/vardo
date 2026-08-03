/** Docker container state to status chip variant. */
export function containerStateVariant(
  state: string,
): "success" | "error" | "info" | "neutral" {
  if (state === "running") return "success";
  if (state === "exited" || state === "dead") return "error";
  if (state === "restarting") return "info";
  return "neutral";
}
