import { describe, expect, it } from 'vitest';

import {
  beginSubmission,
  markSubmissionUncertain,
  readSubmissions,
  requestDigest,
  SubmissionBlockedError,
} from './submissions';

describe('submission records', () => {
  it('reuses a record for the same payload and stores metadata without attachment bytes', () => {
    const first = beginSubmission(
      'steer-run',
      'run-1',
      { message: 'Continue', attachments: [{ data: 'secret-bytes' }] },
      { message: 'Continue', attachmentCount: 1 },
    );
    const second = beginSubmission(
      'steer-run',
      'run-1',
      { message: 'Continue', attachments: [{ data: 'secret-bytes' }] },
      { message: 'Continue', attachmentCount: 1 },
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(readSubmissions())).not.toContain('secret-bytes');
  });

  it('blocks changed payloads while the previous outcome is uncertain', () => {
    const first = beginSubmission(
      'follow-up-run',
      'run-1',
      { message: 'First' },
      { message: 'First' },
    );
    markSubmissionUncertain(first);

    expect(() =>
      beginSubmission('follow-up-run', 'run-1', { message: 'Changed' }, { message: 'Changed' }),
    ).toThrow(SubmissionBlockedError);
  });

  it('uses a stable digest independent of object key order', () => {
    expect(requestDigest({ b: 2, a: 1 })).toBe(requestDigest({ a: 1, b: 2 }));
  });
});
