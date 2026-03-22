const SECRET_PATTERNS = ["password", "secret", "_key", "jwt"];

export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_PATTERNS.some((p) => lower.includes(p));
}
