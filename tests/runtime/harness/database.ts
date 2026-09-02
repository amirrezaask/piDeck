import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

type SqliteStatement = {
  all: (...parameters: unknown[]) => Record<string, unknown>[]
  run: (...parameters: unknown[]) => unknown
}

type DatabaseConnection = {
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

function dbPathFor(dataDir: string): string {
  return path.join(dataDir, "yaade.sqlite3")
}

function openSqlite(dbPath: string): DatabaseConnection | null {
  if (!fs.existsSync(dbPath)) return null
  try {
    const loaded = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { timeout?: number },
      ) => DatabaseConnection
    }
    return new loaded.DatabaseSync(dbPath, { timeout: 5_000 })
  } catch {
    return null
  }
}

function tableRows(db: DatabaseConnection, sql: string): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all()
  } catch {
    return []
  }
}

export function expireUnusedPairingCodes(dataDir: string): void {
  const dbPath = dbPathFor(dataDir)
  const db = openSqlite(dbPath)
  if (!db) throw new Error(`database missing at ${dbPath}`)
  try {
    db.prepare("UPDATE pairing_codes SET expires_at=? WHERE used_at IS NULL").run(
      "2000-01-01T00:00:00.000Z",
    )
  } finally {
    db.close()
  }
}

export function listAuditEvents(dataDir: string): Array<Record<string, unknown>> {
  const dbPath = dbPathFor(dataDir)
  const db = openSqlite(dbPath)
  if (!db) return []
  try {
    return tableRows(
      db,
      "SELECT action,device_id,resource_type,resource_id,details_json FROM audit_events ORDER BY occurred_at ASC",
    )
  } finally {
    db.close()
  }
}
