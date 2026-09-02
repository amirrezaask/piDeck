export interface ParsedUrl {
  readonly hostname: string;
  readonly path: string;
}

const URL_SEPARATORS = /[\s._~:/?#[\]@!$&'()*+,;=%\\-]+/gu;
const REPEATED_WHITESPACE = /\s+/gu;
const DIACRITICS = /\p{M}+/gu;

export const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLocaleLowerCase()
    .replace(URL_SEPARATORS, ' ')
    .replace(REPEATED_WHITESPACE, ' ')
    .trim();

export const parseTabUrl = (value: string): ParsedUrl => {
  try {
    const url = new URL(value);
    const hostname = url.hostname || url.protocol.replace(':', '');
    const path = `${url.pathname}${url.search}${url.hash}`;
    return { hostname, path: path === '/' ? '' : path };
  } catch {
    const normalized = value.trim();
    const [head = normalized, ...tail] = normalized.split('/');
    return { hostname: head, path: tail.length > 0 ? `/${tail.join('/')}` : '' };
  }
};
