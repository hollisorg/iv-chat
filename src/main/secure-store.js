// Small encrypted files in the profile folder, protected by Windows (DPAPI) through Electron's safeStorage.
// Used for the Telegram session and app keys. Nothing here is ever logged.
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const file = (name) => path.join(app.getPath('userData'), `${name}.bin`)

export function readSecret(name) {
  try {
    const buf = fs.readFileSync(file(name))
    return JSON.parse(safeStorage.decryptString(buf))
  } catch {
    return null
  }
}

export function writeSecret(name, value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is not available, so IV Chat cannot store this safely')
  fs.mkdirSync(path.dirname(file(name)), { recursive: true })
  fs.writeFileSync(file(name), safeStorage.encryptString(JSON.stringify(value)))
}

export function deleteSecret(name) {
  fs.rmSync(file(name), { force: true })
}
