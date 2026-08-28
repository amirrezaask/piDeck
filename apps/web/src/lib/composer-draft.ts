import { useEffect, useRef, useState } from 'react';

const DRAFT_STORAGE_PREFIX = 'pideck.composer-draft.v1.';
const DRAFT_WRITE_DELAY_MS = 250;
const MAX_PERSISTED_DRAFT_LENGTH = 1_000_000;

export function readComposerDraft(id: string): string {
  try {
    return (globalThis.localStorage.getItem(draftStorageKey(id)) ?? '').slice(
      0,
      MAX_PERSISTED_DRAFT_LENGTH,
    );
  } catch {
    return '';
  }
}

export function writeComposerDraft(id: string, value: string): void {
  try {
    const key = draftStorageKey(id);
    if (value.length === 0) {
      globalThis.localStorage.removeItem(key);
      return;
    }
    globalThis.localStorage.setItem(key, value.slice(0, MAX_PERSISTED_DRAFT_LENGTH));
  } catch {
    // Draft persistence is a recovery aid; storage failures must not block typing or sending.
  }
}

export function clearComposerDraft(id: string): void {
  writeComposerDraft(id, '');
}

export function useComposerDraft(id: string) {
  const [value, setValue] = useState(() => readComposerDraft(id));
  const latestValueRef = useRef(value);

  useEffect(() => {
    latestValueRef.current = value;
    const timer = globalThis.setTimeout(() => writeComposerDraft(id, value), DRAFT_WRITE_DELAY_MS);
    return () => globalThis.clearTimeout(timer);
  }, [id, value]);

  useEffect(
    () => () => {
      writeComposerDraft(id, latestValueRef.current);
    },
    [id],
  );

  const clear = () => {
    latestValueRef.current = '';
    clearComposerDraft(id);
    setValue('');
  };

  return [value, setValue, clear] as const;
}

function draftStorageKey(id: string): string {
  return `${DRAFT_STORAGE_PREFIX}${id}`;
}
