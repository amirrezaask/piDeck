import { normalizeSearchText } from './normalize';

export interface TextSegment {
  readonly text: string;
  readonly matched: boolean;
}

export const highlightMatch = (text: string, query: string): readonly TextSegment[] => {
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0) return [{ text, matched: false }];
  const index = text.toLocaleLowerCase().indexOf(normalized);
  if (index < 0) return [{ text, matched: false }];
  return [
    { text: text.slice(0, index), matched: false },
    { text: text.slice(index, index + normalized.length), matched: true },
    { text: text.slice(index + normalized.length), matched: false },
  ].filter((segment) => segment.text.length > 0);
};
