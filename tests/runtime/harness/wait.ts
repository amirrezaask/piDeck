export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise<void>(resolve => setTimeout(resolve, 40))
  }
  const detail = lastError instanceof Error ? `\n${lastError.message}` : ""
  throw new Error(`timed out waiting for ${label}${detail}`)
}

export async function waitForHttpOk(url: string, timeoutMs = 30_000): Promise<void> {
  await waitUntil(
    async () => {
      const response = await fetch(url)
      return response.ok
    },
    timeoutMs,
    url,
  )
}
