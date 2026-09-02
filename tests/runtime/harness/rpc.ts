export type RpcSuccess = { value: unknown }
export type RpcFailure = { error: unknown }

export async function hostRpcResult(
  origin: string,
  channel: string,
  args: unknown[],
  clientId = "runtime-e2e",
  token?: string,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: unknown }> {
  const response = await fetch(`${origin}/terminal/api/v1/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ channel, args, clientId }),
  })
  const body = (await response.json()) as RpcSuccess | RpcFailure
  if (!response.ok || "error" in body) {
    return { ok: false, status: response.status, error: "error" in body ? body.error : body }
  }
  return { ok: true, value: body.value }
}

export function rpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}
