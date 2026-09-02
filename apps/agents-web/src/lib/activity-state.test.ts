import { afterEach, describe, expect, it } from 'vitest';
import { activitySince, readCheckedActivity, writeCheckedActivity } from './activity-state';

describe('activity state', () => {
  afterEach(() => window.localStorage.clear());

  it('stores checked event sequences and ignores malformed values', () => {
    writeCheckedActivity({ 'local:run-1': 42 });
    expect(readCheckedActivity()).toEqual({ 'local:run-1': 42 });

    window.localStorage.setItem(
      'pideck.checked-activity.v1',
      JSON.stringify({ valid: 7, negative: -1, text: '9' }),
    );
    expect(readCheckedActivity()).toEqual({ valid: 7 });
  });

  it('returns only activity after the checked sequence', () => {
    expect(activitySince(12, 8)).toBe(4);
    expect(activitySince(8, 12)).toBe(0);
    expect(activitySince(undefined, 0)).toBe(0);
  });
});
