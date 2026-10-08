/** Helper text under a CPU limit field. Blank uses the tier default, 0 removes the cap. */
export function cpuLimitHint(value: string): string {
  if (value.trim() === "") return "Blank uses the default for this tier. 0 removes the cap.";
  const cores = Number(value);
  if (!Number.isFinite(cores)) return "Enter a number of cores.";
  return cores === 0 ? "No CPU cap." : `${cores} CPU core(s)`;
}
