const CHECKED_ACTIVITY_STORAGE_KEY = 'pideck.checked-activity.v1';

export type CheckedActivity = Record<string, number>;

export function readCheckedActivity(): CheckedActivity {
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage.getItem(CHECKED_ACTIVITY_STORAGE_KEY) ?? '{}',
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

export function writeCheckedActivity(value: CheckedActivity): void {
  try {
    const bounded = Object.fromEntries(Object.entries(value).slice(-2_000));
    globalThis.localStorage.setItem(CHECKED_ACTIVITY_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Activity markers are a convenience; storage failures must not block supervision.
  }
}

export function activitySince(latestSequence: number | undefined, checkedSequence: number): number {
  return Math.max(0, (latestSequence ?? 0) - checkedSequence);
}
