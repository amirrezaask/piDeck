/**
 * HTML-only rewrite for Vite `transformIndexHtml`.
 * Kept free of `import.meta` so vite.config can import it under CJS.
 */
export function applyDevBuildBrandingToHtml(html: string): string {
  return html
    .replaceAll('href="/favicon.png"', 'href="/favicon-dev.png"')
    .replaceAll(
      'href="/apple-touch-icon.png"',
      'href="/apple-touch-icon-dev.png"',
    )
    .replace("<title>YAADE</title>", "<title>DEV · YAADE</title>")
}
