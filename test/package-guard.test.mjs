import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { borrowedFolder } from '../src/main/package-guard.js'
import { createStore } from '../src/main/unlock-store.js'

// A pretend Windows: AppData and LocalAppData in a temp folder, with one other app's package installed.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-guard-'))
  const appData = path.join(root, 'Roaming')
  const localAppData = path.join(root, 'Local')
  const userData = path.join(appData, 'IV Chat')
  fs.mkdirSync(path.join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
  fs.mkdirSync(path.join(localAppData, 'Packages', 'Microsoft.Photos_8wekyb3d8bbwe'), { recursive: true })
  return { appData, localAppData, userData }
}

// Like Windows inside a package: new files under AppData land in that package's private copy instead.
function redirected({ appData, localAppData }, pkg) {
  const copy = (p) => path.join(localAppData, 'Packages', pkg, 'LocalCache', 'Roaming', path.relative(appData, p))
  return {
    ...fs,
    mkdirSync: (p, o) => fs.mkdirSync(copy(p), o),
    writeFileSync: (p, d) => fs.writeFileSync(copy(p), d),
    rmSync: (p, o) => fs.rmSync(copy(p), o)
  }
}

test('started normally, the folder is its own', () => {
  const env = setup()
  assert.equal(borrowedFolder(env), null)
  assert.deepEqual(fs.readdirSync(env.userData), [], 'the marker is removed')
})

test('started inside another app\'s package, it names that app and finds the copy', () => {
  const env = setup()
  const found = borrowedFolder({ ...env, files: redirected(env, 'Claude_pzs8sxrjxfjjc') })
  assert.equal(found.app, 'Claude')
  assert.equal(found.folder, path.join(env.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'IV Chat'))
  assert.deepEqual(fs.readdirSync(found.folder), [], 'the marker is removed from the copy too')
})

test('an old leftover copy from another app doesn\'t count, only where this start\'s marker lands', () => {
  const env = setup()
  fs.mkdirSync(path.join(env.localAppData, 'Packages', 'Microsoft.Photos_8wekyb3d8bbwe', 'LocalCache', 'Roaming', 'IV Chat'), { recursive: true })
  assert.equal(borrowedFolder(env), null)
})

test('a profile outside AppData, or a failed check, never blocks IV Chat', () => {
  const env = setup()
  assert.equal(borrowedFolder({ ...env, userData: path.join(os.tmpdir(), 'iv-chat-test-profile') }), null)
  assert.equal(borrowedFolder({ ...env, localAppData: path.join(env.localAppData, 'missing') }), null)
  assert.equal(borrowedFolder({ ...env, files: { ...fs, writeFileSync: () => { throw new Error('denied') } } }), null)
})

test('a held store reads but never writes or deletes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-hold-'))
  const key = { available: () => true, encrypt: (t) => Buffer.from(`A:${t}`), decrypt: (b) => b.toString().slice(2) }
  const first = createStore(dir, key)
  first.checkUnlock()
  first.writeSecret('telegram-session', { session: 'S' })
  const held = createStore(dir, key)
  held.hold()
  assert.equal(held.isLocked(), true)
  assert.deepEqual(held.readSecret('telegram-session'), { session: 'S' })
  assert.throws(() => held.writeSecret('telegram-session', { session: 'NEW' }))
  held.deleteSecret('telegram-session')
  assert.equal(fs.existsSync(path.join(dir, 'telegram-session.bin')), true)
})
