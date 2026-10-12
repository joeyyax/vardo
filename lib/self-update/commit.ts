/** Match a full commit to the short SHA stored by older Vardo versions. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const length = Math.min(x.length, y.length);
  return length >= 7 && x.slice(0, length) === y.slice(0, length);
}
