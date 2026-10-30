// Small encrypted files in the profile folder, protected by Windows (DPAPI) through Electron's safeStorage.
// Used for the Telegram session and app keys. Nothing here is ever logged. The logic, including the startup
// check that the Windows key unlocks, is in unlock-store.js.
import { app, safeStorage } from 'electron'
import { createStore } from './unlock-store'

let store = null
const get = () =>
  (store ??= createStore(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf)
  }))

export const checkUnlock = () => get().checkUnlock()
export const isLocked = () => get().isLocked()
export const forgetLocked = () => get().forget()
export const holdStore = () => get().hold()
export const readSecret = (name) => get().readSecret(name)
export const writeSecret = (name, value) => get().writeSecret(name, value)
export const deleteSecret = (name) => get().deleteSecret(name)
