/**
 * Entry parser for the smart entry bar.
 * Extracts structured data (duration, date, entity candidates) from free-form text.
 */

// Types

export interface ParsedDuration {
  type: "duration";
  value: number; // minutes
  raw: string;
  start: number;
  end: number;
}

export interface ParsedDate {
  type: "date";
  value: Date;
  raw: string;
  start: number;
  end: number;
}

export interface EntityCandidate {
  type: "entity";
  text: string;
  start: number;
  end: number;
  isDescriptionContext: boolean;
}

export interface ParseResult {
  duration: ParsedDuration | null;
  date: ParsedDate | null;
  candidates: EntityCandidate[];
  descriptionText: string;
}

// Common words to filter out from entity candidates
const COMMON_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "on",
  "at",
  "in",
  "with",
]);

// Description context phrases - words after these are likely description, not entities
const DESCRIPTION_CONTEXT_PHRASES = [
  "meeting with",
  "call with",
  "working on",
  "call about",
  "meeting about",
  "discussion with",
  "review of",
  "updates to",
  "changes to",
  "fixes for",
  "fix for",
];

// Day name to day-of-week mapping (0 = Sunday)
const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Duration patterns (order matters - more specific patterns first)
const DURATION_PATTERNS = [
  // 1:30 (hours:minutes)
  /(\d+):(\d{2})\b/,
  // 1h30m or 1h 30m
  /(\d+)\s*h\s*(\d+)\s*m(?:in)?\b/i,
  // 1.5h or 1h
  /(\d+(?:\.\d+)?)\s*h(?:our)?s?\b/i,
  // 90m or 90min
  /(\d+)\s*m(?:in(?:ute)?s?)?\b/i,
];

/**
 * Parse duration from input text.
 * Returns minutes and the match array, or null if no duration found.
 */
export function parseDuration(
  input: string
): { minutes: number; match: RegExpMatchArray } | null {
  // Try each pattern in order
  for (const pattern of DURATION_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      const patternStr = pattern.source;

      // 1:30 format (hours:minutes)
      if (patternStr.includes(":")) {
        const hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        return { minutes: hours * 60 + mins, match };
      }

      // 1h30m or 1h 30m format
      if (patternStr.includes("h\\s*") && patternStr.includes("m")) {
        const hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        return { minutes: hours * 60 + mins, match };
      }

      // 1.5h or 1h format
      if (patternStr.includes("h(?:our)?")) {
        const hours = parseFloat(match[1]);
        return { minutes: Math.round(hours * 60), match };
      }

      // 90m or 90min format
      if (patternStr.includes("m(?:in")) {
        const mins = parseInt(match[1], 10);
        return { minutes: mins, match };
      }
    }
  }

  return null;
}

/**
 * Parse relative date keywords from input text.
 * Returns the resolved Date or null if no date keyword found.
 */
export function parseRelativeDate(input: string): Date | null {
  const lowerInput = input.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check for "today"
  if (/\btoday\b/.test(lowerInput)) {
    return today;
  }

  // Check for "yesterday"
  if (/\byesterday\b/.test(lowerInput)) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }

  // Check for day names (resolve to most recent occurrence)
  for (const [dayName, dayOfWeek] of Object.entries(DAY_NAMES)) {
    const regex = new RegExp(`\\b${dayName}\\b`, "i");
    if (regex.test(lowerInput)) {
      const currentDayOfWeek = today.getDay();
      let daysAgo = currentDayOfWeek - dayOfWeek;

      // If the day is today or in the future this week, go back a full week
      if (daysAgo <= 0) {
        daysAgo += 7;
      }

      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() - daysAgo);
      return targetDate;
    }
  }

  return null;
}

/**
 * Find the position of a relative date keyword in the input.
 */
function findDateKeywordPosition(
  input: string
): { start: number; end: number; raw: string } | null {
  const lowerInput = input.toLowerCase();

  // Check for "today"
  const todayMatch = lowerInput.match(/\btoday\b/);
  if (todayMatch && todayMatch.index !== undefined) {
    return {
      start: todayMatch.index,
      end: todayMatch.index + todayMatch[0].length,
      raw: input.slice(todayMatch.index, todayMatch.index + todayMatch[0].length),
    };
  }

  // Check for "yesterday"
  const yesterdayMatch = lowerInput.match(/\byesterday\b/);
  if (yesterdayMatch && yesterdayMatch.index !== undefined) {
    return {
      start: yesterdayMatch.index,
      end: yesterdayMatch.index + yesterdayMatch[0].length,
      raw: input.slice(
        yesterdayMatch.index,
        yesterdayMatch.index + yesterdayMatch[0].length
      ),
    };
  }

  // Check for day names
  for (const dayName of Object.keys(DAY_NAMES)) {
    const regex = new RegExp(`\\b${dayName}\\b`, "i");
    const match = lowerInput.match(regex);
    if (match && match.index !== undefined) {
      return {
        start: match.index,
        end: match.index + match[0].length,
        raw: input.slice(match.index, match.index + match[0].length),
      };
    }
  }

  return null;
}

/**
 * Find positions of description context phrases in the input.
 * Returns an array of end positions for each phrase found.
 */
function findDescriptionContextPositions(input: string): number[] {
  const lowerInput = input.toLowerCase();
  const positions: number[] = [];

  for (const phrase of DESCRIPTION_CONTEXT_PHRASES) {
    let searchPos = 0;
    while (searchPos < lowerInput.length) {
      const index = lowerInput.indexOf(phrase, searchPos);
      if (index === -1) break;
      positions.push(index + phrase.length);
      searchPos = index + 1;
    }
  }

  return positions.sort((a, b) => a - b);
}

/**
 * Parse entry text and extract structured data.
 * Finds duration, relative date, and entity candidates from free-form text.
 */
export function parseEntryText(input: string): ParseResult {
  const result: ParseResult = {
    duration: null,
    date: null,
    candidates: [],
    descriptionText: "",
  };

  if (!input.trim()) {
    return result;
  }

  // Track positions to exclude from entity candidate extraction
  const excludedRanges: Array<{ start: number; end: number }> = [];

  // Parse duration
  const durationResult = parseDuration(input);
  if (durationResult) {
    const { minutes, match } = durationResult;
    const start = match.index ?? 0;
    const end = start + match[0].length;

    result.duration = {
      type: "duration",
      value: minutes,
      raw: match[0],
      start,
      end,
    };

    excludedRanges.push({ start, end });
  }

  // Parse date
  const dateValue = parseRelativeDate(input);
  if (dateValue) {
    const datePosition = findDateKeywordPosition(input);
    if (datePosition) {
      result.date = {
        type: "date",
        value: dateValue,
        raw: datePosition.raw,
        start: datePosition.start,
        end: datePosition.end,
      };

      excludedRanges.push({ start: datePosition.start, end: datePosition.end });
    }
  }

  // Find description context phrase positions
  const descriptionContextEnds = findDescriptionContextPositions(input);

  // Extract remaining text as potential entity candidates
  // Split by whitespace and track positions
  const words: Array<{ text: string; start: number; end: number }> = [];
  const wordRegex = /\S+/g;
  let wordMatch: RegExpExecArray | null;

  while ((wordMatch = wordRegex.exec(input)) !== null) {
    words.push({
      text: wordMatch[0],
      start: wordMatch.index,
      end: wordMatch.index + wordMatch[0].length,
    });
  }

  // Filter words to create entity candidates
  for (const word of words) {
    // Skip if word overlaps with excluded ranges (duration, date)
    const isExcluded = excludedRanges.some(
      (range) => word.start < range.end && word.end > range.start
    );
    if (isExcluded) continue;

    // Skip common words
    const lowerText = word.text.toLowerCase();
    if (COMMON_WORDS.has(lowerText)) continue;

    // Determine if this word follows a description context phrase
    const isDescriptionContext = descriptionContextEnds.some((phraseEnd) => {
      // Check if word starts after or at the phrase end (with possible whitespace)
      return word.start >= phraseEnd && word.start <= phraseEnd + 1;
    });

    // Mark all subsequent words as description context too
    const isAfterDescriptionContext = descriptionContextEnds.some(
      (phraseEnd) => word.start > phraseEnd
    );

    result.candidates.push({
      type: "entity",
      text: word.text,
      start: word.start,
      end: word.end,
      isDescriptionContext: isDescriptionContext || isAfterDescriptionContext,
    });
  }

  // Build description text from candidates marked as description context
  const descriptionParts = result.candidates
    .filter((c) => c.isDescriptionContext)
    .map((c) => c.text);
  result.descriptionText = descriptionParts.join(" ");

  return result;
}
