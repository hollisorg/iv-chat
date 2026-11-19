// The IV Newsletter signup, main-process side. Shared by every IV app (standing rule in IVAI AGENTS.md); the source
// of truth is IVAI docs/newsletter/apps/newsletter-main.js, copied into each app unchanged.
//
// Opt-in only: nothing is sent until the person types an address and clicks Join. The request goes to the
// iv-newsletter function's app path (no Origin header, X-IV-App names the app); Kit then emails them a confirm link
// (double opt-in). This file keeps no address: only when they joined and whether the first-run card was closed.
// No key or secret lives in the app. Test copies set IV_NEWSLETTER_URL to a local stand-in so nothing reaches Kit.
//
// Existing data is never touched (Matthew, 2026-11-19: people's saved data in the apps needs a safeguard). This file
// only ever reads and writes its own `newsletter.json`: fileStore refuses any other file name, writes through a
// temporary file and a rename so a crash can't leave a half-written file, never deletes anything, and a failed write
// never breaks the app. newsletter-main.test.mjs proves every other file in the folder stays byte-for-byte the same.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { basename, dirname } from 'node:path'

export const NEWSLETTER_URL = 'https://utajiwjbzrpwjtbcsnly.supabase.co/functions/v1/iv-newsletter'
export const NEWSLETTER_PAGE = 'https://infinitevariance.ai/newsletter'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// A tiny JSON file store for newsletter.json and nothing else.
export function fileStore(path) {
  if (basename(path) !== 'newsletter.json') throw new Error('The newsletter store only writes newsletter.json')
  return {
    get() { try { return JSON.parse(readFileSync(path, 'utf8')) || {} } catch { return {} } },
    set(value) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = path + '.tmp'
      writeFileSync(tmp, JSON.stringify(value, null, 2))
      renameSync(tmp, path)
    }
  }
}

export function createNewsletter({ app, version, store, fetch: call = globalThis.fetch, url, now = () => new Date() }) {
  const endpoint = url || process.env.IV_NEWSLETTER_URL || NEWSLETTER_URL
  let busy = false
  const read = () => { const s = store.get() || {}; return { joinedAt: s.joinedAt || null, cardClosedAt: s.cardClosedAt || null } }
  // A failed save (disk full, locked folder) must never break the app or the join; worst case the box forgets.
  const write = (patch) => { try { store.set({ ...read(), ...patch }) } catch { /* keep going */ } }

  return {
    status: () => ({ ...read(), page: NEWSLETTER_PAGE }),

    // The person clicked Join. Returns {ok:true, joinedAt} or {ok:false, error, field?, offline?}.
    async join(input = {}) {
      const email = String(input.email || '').trim()
      if (!EMAIL.test(email) || email.length > 254) return { ok: false, field: 'email', error: 'Please enter a valid email address.' }
      if (busy) return { ok: false, error: 'Already sending. One moment.' }
      busy = true
      try {
        const res = await call(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-IV-App': app },
          body: JSON.stringify({ email, source: 'app', app, app_version: version }),
          signal: AbortSignal.timeout(15000)
        })
        let body = {}
        try { body = await res.json() } catch { /* not JSON */ }
        if (res.ok && body.ok) {
          const joinedAt = now().toISOString()
          write({ joinedAt })
          return { ok: true, joinedAt }
        }
        if (res.status === 400 && body.field === 'email') return { ok: false, field: 'email', error: body.error || 'Please enter a valid email address.' }
        if (res.status === 429 || res.status === 503) return { ok: false, error: body.error || 'Lots of signups right now. Please try again in a minute.' }
        return { ok: false, offline: true, error: "Couldn't reach the signup service." }
      } catch {
        return { ok: false, offline: true, error: "Couldn't reach the signup service." }
      } finally {
        busy = false
      }
    },

    // The person closed the first-run card ("Not now"). It never shows again.
    closeCard() { write({ cardClosedAt: now().toISOString() }); return read() }
  }
}

// Wire it to Electron. `shell` opens the website page in the browser (the fallback when the service is down).
export function registerNewsletter(ipcMain, shell, newsletter) {
  ipcMain.handle('newsletter:status', () => newsletter.status())
  ipcMain.handle('newsletter:join', (_e, input) => newsletter.join(input))
  ipcMain.handle('newsletter:close-card', () => newsletter.closeCard())
  ipcMain.handle('newsletter:open-page', () => shell.openExternal(NEWSLETTER_PAGE))
}
