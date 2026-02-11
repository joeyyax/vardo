import { nanoid } from "nanoid";

export function generateScopeToken(): string {
  return `sc_${nanoid(24)}`;
}
