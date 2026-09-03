const INJECTABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:']);
const WEB_STORE_HOSTS = new Set(['chrome.google.com', 'chromewebstore.google.com']);

export const isInjectableUrl = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return INJECTABLE_PROTOCOLS.has(url.protocol) && !WEB_STORE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};
