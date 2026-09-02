export type DeviceIdentity = {
  readonly deviceId: string
  readonly publicKey: JsonWebKey
  /** Non-extractable; persisted as an IndexedDB CryptoKey handle. */
  readonly privateKey: CryptoKey
  readonly sign: (nonce: string) => Promise<string>
}

/** Generate a non-extractable browser signing key for a paired device. */
export async function createDeviceIdentity(
  cryptoSource: Crypto = globalThis.crypto,
): Promise<DeviceIdentity> {
  const keyPair = await cryptoSource.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"],
  )
  if (!("privateKey" in keyPair) || !("publicKey" in keyPair)) {
    throw new Error("browser does not support Ed25519 device keys")
  }
  const privateKey = keyPair.privateKey
  const publicKey = await cryptoSource.subtle.exportKey("jwk", keyPair.publicKey)
  const deviceId = cryptoSource.randomUUID()
  return {
    deviceId,
    publicKey,
    privateKey,
    sign: async (nonce: string) => {
      const signature = await cryptoSource.subtle.sign(
        "Ed25519",
        privateKey,
        new TextEncoder().encode(nonce),
      )
      return bytesToBase64Url(new Uint8Array(signature))
    },
  }
}

const DEVICE_DB_NAME = "yaade-device-auth"
const DEVICE_STORE_NAME = "identity"

export async function saveDeviceIdentity(
  identity: DeviceIdentity,
  database: IDBFactory = indexedDB,
): Promise<void> {
  const db = await openDeviceDatabase(database)
  await new Promise<void>((resolve, reject) => {
    const request = db
      .transaction(DEVICE_STORE_NAME, "readwrite")
      .objectStore(DEVICE_STORE_NAME)
      .put(
        { deviceId: identity.deviceId, publicKey: identity.publicKey, privateKey: identity.privateKey },
        "current",
      )
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error("could not save device identity"))
  })
  db.close()
}

export async function loadDeviceIdentity(
  cryptoSource: Crypto = globalThis.crypto,
  database: IDBFactory = indexedDB,
): Promise<DeviceIdentity | null> {
  const db = await openDeviceDatabase(database)
  const stored = await new Promise<StoredDeviceIdentity | null>((resolve, reject) => {
    const request = db.transaction(DEVICE_STORE_NAME, "readonly").objectStore(DEVICE_STORE_NAME).get("current")
    request.onsuccess = () => resolve(isStoredDeviceIdentity(request.result) ? request.result : null)
    request.onerror = () => reject(request.error ?? new Error("could not load device identity"))
  })
  db.close()
  if (!stored) return null
  return makeDeviceIdentity(cryptoSource, stored)
}

type StoredDeviceIdentity = {
  readonly deviceId: string
  readonly publicKey: JsonWebKey
  readonly privateKey: CryptoKey
}

function isStoredDeviceIdentity(value: unknown): value is StoredDeviceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.deviceId === "string" &&
    typeof record.publicKey === "object" && record.publicKey !== null &&
    record.privateKey instanceof CryptoKey
}

function makeDeviceIdentity(
  cryptoSource: Crypto,
  stored: StoredDeviceIdentity,
): DeviceIdentity {
  return {
    ...stored,
    sign: async (nonce: string) => {
      const signature = await cryptoSource.subtle.sign(
        "Ed25519",
        stored.privateKey,
        new TextEncoder().encode(nonce),
      )
      return bytesToBase64Url(new Uint8Array(signature))
    },
  }
}

function openDeviceDatabase(database: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = database.open(DEVICE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DEVICE_STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("could not open device identity store"))
  })
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}
