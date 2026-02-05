/**
 * User preferences stored in localStorage.
 * These are UI preferences that affect behavior but don't need server sync.
 */

const PREFERENCES_KEY = "time-user-preferences";

export interface UserPreferences {
  /** Keep client/project/task/date selections after saving an entry */
  stickySelections: boolean;
}

const defaultPreferences: UserPreferences = {
  stickySelections: false,
};

/**
 * Get user preferences from localStorage.
 */
export function getUserPreferences(): UserPreferences {
  if (typeof window === "undefined") return defaultPreferences;

  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (!stored) return defaultPreferences;

    const parsed = JSON.parse(stored);
    return { ...defaultPreferences, ...parsed };
  } catch {
    return defaultPreferences;
  }
}

/**
 * Set a single user preference.
 */
export function setUserPreference<K extends keyof UserPreferences>(
  key: K,
  value: UserPreferences[K]
): void {
  if (typeof window === "undefined") return;

  try {
    const current = getUserPreferences();
    const updated = { ...current, [key]: value };
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/**
 * Get a single user preference.
 */
export function getUserPreference<K extends keyof UserPreferences>(
  key: K
): UserPreferences[K] {
  return getUserPreferences()[key];
}
