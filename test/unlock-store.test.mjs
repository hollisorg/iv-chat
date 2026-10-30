import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../src/main/unlock-store.js'

// A pretend Windows key: "encrypts" by tagging the text with the key's name, so a different key can't open it.
function fakeKey(name, available = true) {
  return {
    available: () => available,
    encrypt: (text) => Buffer.from(`${name}:${text}`),
    decrypt: (buf) => {
      const s = buf.toString()
      if (!s.startsWith(`${name}:`)) throw new Error('wrong key')
      return s.slice(name.length + 1)
    }
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iv-unlock-'))

test('a profile with the right key unlocks, and keeps its saved sign-ins readable', () => {
  const dir = tmp()
  const store = createStore(dir, fakeKey('A'))
  assert.equal(store.checkUnlock(), 'ok')
  store.writeSecret('telegram-session', { session: 'S' })
  const again = createStore(dir, fakeKey('A'))
  assert.equal(again.checkUnlock(), 'ok')
  assert.deepEqual(again.readSecret('telegram-session'), { session: 'S' })
})

test('when the key can\'t open the saved files, it says locked and writes over nothing', () => {
  const dir = tmp()
  const first = createStore(dir, fakeKey('A'))
  first.checkUnlock()
  first.writeSecret('telegram-session', { session: 'S' })
  const before = fs.readFileSync(path.join(dir, 'telegram-session.bin'))

  const locked = createStore(dir, fakeKey('B'))
  assert.equal(locked.checkUnlock(), 'locked')
  assert.equal(locked.isLocked(), true)
  assert.equal(locked.readSecret('telegram-session'), null)
  assert.throws(() => locked.writeSecret('telegram-session', { session: 'NEW' }), /Restart IV Chat/)
  assert.throws(() => locked.writeSecret('telegram-app', { apiId: 1 }), /Restart IV Chat/)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'telegram-session.bin')), before)

  // A restart with the key back finds everything as it was.
  const restarted = createStore(dir, fakeKey('A'))
  assert.equal(restarted.checkUnlock(), 'ok')
  assert.deepEqual(restarted.readSecret('telegram-session'), { session: 'S' })
})

test('Windows encryption unavailable with sign-ins saved counts as locked; with nothing saved it is new', () => {
  const dir = tmp()
  const first = createStore(dir, fakeKey('A'))
  first.checkUnlock()
  first.writeSecret('telegram-session', { session: 'S' })
  assert.equal(createStore(dir, fakeKey('A', false)).checkUnlock(), 'locked')
  assert.equal(createStore(tmp(), fakeKey('A', false)).checkUnlock(), 'new')
})

test('a profile from before the check file is tested against its own secrets', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'telegram-session.bin'), fakeKey('A').encrypt(JSON.stringify({ session: 'S' })))
  assert.equal(createStore(dir, fakeKey('B')).checkUnlock(), 'locked')
  assert.equal(fs.existsSync(path.join(dir, 'unlock-check.bin')), false, 'no check file is made with the wrong key')
  assert.equal(createStore(dir, fakeKey('A')).checkUnlock(), 'ok')
  assert.equal(fs.existsSync(path.join(dir, 'unlock-check.bin')), true)
})

test('even unlocked, a single saved file that can\'t be opened is not written over', () => {
  const dir = tmp()
  const store = createStore(dir, fakeKey('A'))
  store.checkUnlock()
  fs.writeFileSync(path.join(dir, 'telegram-session.bin'), fakeKey('B').encrypt('{}'))
  assert.throws(() => store.writeSecret('telegram-session', { session: 'NEW' }), /won't write over it/)
})

test('Start over removes only what can\'t be opened, then works with the current key', () => {
  const dir = tmp()
  const old = createStore(dir, fakeKey('A'))
  old.checkUnlock()
  old.writeSecret('telegram-session', { session: 'S' })
  fs.writeFileSync(path.join(dir, 'other.txt'), 'kept')

  const store = createStore(dir, fakeKey('B'))
  assert.equal(store.checkUnlock(), 'locked')
  assert.equal(store.forget(), 'ok')
  assert.equal(store.isLocked(), false)
  assert.equal(fs.existsSync(path.join(dir, 'telegram-session.bin')), false)
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'kept')
  store.writeSecret('telegram-session', { session: 'NEW' })
  assert.deepEqual(createStore(dir, fakeKey('B')).readSecret('telegram-session'), { session: 'NEW' })
})
