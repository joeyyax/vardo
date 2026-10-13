// A short reference that identifies a ban to a person, like a pickup number: "13-K7M2", shown as "403-13-K7M2". The first
// part is the day of the month the ban was made (UTC); the second is four characters derived from the ban id. Nothing is
// stored, so the admin list can search by it. Not unique by construction: two bans made the same day can share a code,
// and the address and time tell them apart.

// 32 symbols without 0, 1, I or O, which read as each other aloud and in print.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 4;
const SPACE = ALPHABET.length ** CODE_LENGTH;
const REF_RE = new RegExp(`^\\d{2}-[${ALPHABET}]{${CODE_LENGTH}}$`);

/** 53-bit string hash (cyrb53). Pure and the same in Node and the browser. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function banCode(banId: string): string {
  let n = hash53(banId) % SPACE;
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code = ALPHABET[n % ALPHABET.length] + code;
    n = Math.floor(n / ALPHABET.length);
  }
  return code;
}

function banDay(createdAt: Date | string): string {
  const day = new Date(createdAt).getUTCDate();
  return Number.isFinite(day) ? String(day).padStart(2, "0") : "00";
}

/** The reference for a ban: the UTC day it was made and a four-character code, as in "13-K7M2". */
export function banRef(banId: string, createdAt: Date | string): string {
  return `${banDay(createdAt)}-${banCode(banId)}`;
}

/** Whether a string has the shape banRef() produces. */
export function isBanRef(value: string): boolean {
  return REF_RE.test(value);
}

/** What a visitor sees: the status in front, as in "403-13-K7M2". */
export function displayRef(status: number, ref: string): string {
  return `${status}-${ref}`;
}

/** A search as someone might type it: any case, spaces or dashes, with or without the status and the day. */
export function parseRef(input: string): { day?: string; code: string } {
  const tokens = input.toUpperCase().split(/[\s-]+/).filter(Boolean);
  if (tokens[0] === "403") tokens.shift();
  let joined = tokens.join("").replace(/[^A-Z0-9]/g, "");
  // Codes and days never contain 0 or start with 40, so a leading "403" is always the status.
  if (joined.startsWith("403") && joined.length > 3) joined = joined.slice(3);
  if (tokens.length >= 2 && /^\d{2}$/.test(tokens[0])) return { day: tokens[0], code: tokens.slice(1).join("").replace(/[^A-Z0-9]/g, "") };
  if (joined.length > CODE_LENGTH && /^\d{2}/.test(joined)) return { day: joined.slice(0, 2), code: joined.slice(2) };
  return { code: joined };
}

/** Whether a search matches a ban. A partial code matches from its start; a day, when typed, must match exactly. */
export function matchesRef(banId: string, createdAt: Date | string, query: string): boolean {
  const { day, code } = parseRef(query);
  if (day === undefined && code === "") return true;
  if (day !== undefined && day !== banDay(createdAt)) return false;
  const codeMatches = banCode(banId).startsWith(code);
  // Two digits alone are a day as often as the start of a code.
  return day === undefined && /^\d{2}$/.test(code) ? codeMatches || code === banDay(createdAt) : codeMatches;
}
