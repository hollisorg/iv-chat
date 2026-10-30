// The encrypted store behind secure-store.js, without Electron, so it can be tested.
//
// Electron's safeStorage and the website panels' cookies share one Windows-protected key. If IV Chat can't
// unlock it (seen once right after a Windows restart), every sign-in looks gone even though it's all still
// on disk. So at startup checkUnlock() tests that key against a small check file, and while it's locked
// nothing here writes over a saved file: signing in again would replace a sign-in that a restart brings back.
import fs from 'node:fs'
import path from 'node:path'

const CHECK = 'unlock-check'
const CHECK_TEXT = 'iv-chat-unlock-check'

export function createStore(dir, crypto) {
  const file = (name) => path.join(dir, `${name}.bin`)
  const savedNames = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4)) : [])
  let locked = false

  // 'missing' (never saved), 'ok' (with its value) or 'locked' (saved, but can't be opened now).
  function open(name) {
    let buf
    try {
      buf = fs.readFileSync(file(name))
    } catch {
      return { state: 'missing' }
    }
    try {
      if (!crypto.available()) return { state: 'locked' }
      return { state: 'ok', value: JSON.parse(crypto.decrypt(buf)) }
    } catch {
      return { state: 'locked' }
    }
  }

  return {
    // 'ok', 'locked', or 'new' when nothing is saved yet and Windows encryption isn't available to start.
    checkUnlock() {
      const check = open(CHECK)
      locked = check.state === 'ok' ? check.value !== CHECK_TEXT : check.state === 'locked'
      // Profiles from before the check file: test the saved secrets themselves.
      if (check.state === 'missing') locked = savedNames().some((name) => open(name).state === 'locked')
      if (locked) return 'locked'
      if (check.state === 'ok') return 'ok'
      if (!crypto.available()) return 'new'
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(CHECK), crypto.encrypt(JSON.stringify(CHECK_TEXT)))
      return 'ok'
    },

    isLocked: () => locked,

    readSecret(name) {
      const r = open(name)
      return r.state === 'ok' ? r.value : null
    },

    writeSecret(name, value) {
      if (locked) throw new Error("IV Chat couldn't unlock your saved sign-ins. Restart IV Chat to try again.")
      if (!crypto.available()) throw new Error('Windows encryption is not available, so IV Chat cannot store this safely')
      if (open(name).state === 'locked') throw new Error("IV Chat couldn't unlock this saved sign-in, so it won't write over it. Restart IV Chat to try again.")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(name), crypto.encrypt(JSON.stringify(value)))
    },

    deleteSecret(name) {
      fs.rmSync(file(name), { force: true })
    },

    // "Start over" on the locked screen: the person chose to sign in again rather than restart. Removes only
    // the saved files that can't be opened (and the check file), then checks again.
    forget() {
      for (const name of savedNames()) if (name === CHECK || open(name).state === 'locked') fs.rmSync(file(name), { force: true })
      return this.checkUnlock()
    }
  }
}
