/**
 * Extract hashtags from a description string.
 * Tags must start with # followed by alphanumeric characters, hyphens, or underscores.
 * Returns unique, lowercase tags without the # prefix.
 *
 * @example
 * extractTags("Working on #design and #review") // ["design", "review"]
 * extractTags("Meeting #planning #PLANNING") // ["planning"] (deduplicated)
 * extractTags("No tags here") // []
 */
export function extractTags(description: string | null | undefined): string[] {
  if (!description) return [];

  // Match hashtags: # followed by word characters (letters, numbers, underscore, hyphen)
  const tagRegex = /#([a-zA-Z0-9_-]+)/g;
  const matches = description.matchAll(tagRegex);

  const tags = new Set<string>();
  for (const match of matches) {
    // Normalize to lowercase for consistency
    tags.add(match[1].toLowerCase());
  }

  return Array.from(tags);
}
