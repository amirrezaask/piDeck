const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeServerOrigin(address: string, sendsToken: boolean): string {
  const url = new URL(address.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Server address must use http:// or https://');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter the server origin only, without credentials, query, or path');
  }
  if (sendsToken && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Servers outside this computer must use HTTPS when an access token is saved');
  }
  return url.origin;
}
