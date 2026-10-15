// Where a long name splits so a truncated row keeps its head and its tail. No React.

/** Names this short never split. */
const WHOLE_UP_TO = 12;
/** A last word up to this long is the tail; otherwise the last TAIL_CHARS characters are. */
const TAIL_WORD_MAX = 8;
const TAIL_CHARS = 6;

/** The narrowest a name gets before its tail is measured: about an ellipsis and the tail, or 4.5em when it doesn't split. */
export function middleMinWidth(text: string): string {
  const { tail } = middleSplit(text);
  return tail ? `calc(${tail.length} * 0.6ch + 1ch)` : "4.5em";
}

/** The head, which truncates with an ellipsis, and the tail, which always shows. Joined, they're the name. */
export function middleSplit(text: string): { head: string; tail: string } {
  if (text.length <= WHOLE_UP_TO) return { head: text, tail: "" };
  const space = text.lastIndexOf(" ");
  const word = space > 0 ? text.slice(space + 1) : "";
  const cut = word.length > 0 && word.length <= TAIL_WORD_MAX ? space + 1 : text.length - TAIL_CHARS;
  return { head: text.slice(0, cut), tail: text.slice(cut) };
}
