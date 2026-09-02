import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearComposerDraft,
  readComposerDraft,
  useComposerDraft,
  writeComposerDraft,
} from './composer-draft';

describe('composer drafts', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('persists and clears drafts without throwing when storage is unavailable', () => {
    writeComposerDraft('run-1', 'Keep this prompt');
    expect(readComposerDraft('run-1')).toBe('Keep this prompt');

    clearComposerDraft('run-1');
    expect(readComposerDraft('run-1')).toBe('');
  });

  it('restores a draft and flushes the latest value when the composer unmounts', () => {
    writeComposerDraft('run-2', 'Restored prompt');
    const { result, unmount } = renderHook(() => useComposerDraft('run-2'));
    expect(result.current[0]).toBe('Restored prompt');

    act(() => result.current[1]('Updated prompt'));
    unmount();

    expect(readComposerDraft('run-2')).toBe('Updated prompt');
  });

  it('debounces writes while typing', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useComposerDraft('run-3'));

    act(() => result.current[1]('A careful prompt'));
    expect(readComposerDraft('run-3')).toBe('');

    act(() => vi.advanceTimersByTime(250));
    expect(readComposerDraft('run-3')).toBe('A careful prompt');
  });
});
