// Checks for the shared IV Newsletter sender (newsletter-main.js). Copied into each IV app next to its copy of the
// sender; only the import line changes. Run: node --test <this file>
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNewsletter, fileStore, registerNewsletter, NEWSLETTER_URL, NEWSLETTER_PAGE } from '../src/main/newsletter.js'

const memory = (start = {}) => { let v = start; return { get: () => v, set: (x) => { v = x }, peek: () => v } }
const fakeFetch = (status, body) => {
  const calls = []
  const call = async (url, init) => { calls.push({ url, init }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }) }
  return { calls, call }
}
const make = (f, store = memory(), o = {}) => createNewsletter({ app: 'iv-test', version: '1.2.3', store, fetch: f.call, now: () => new Date('2026-11-19T20:00:00Z'), ...o })

test('join posts to the live function with X-IV-App, no Origin, and the right body', async () => {
  const f = fakeFetch(200, { ok: true })
  const r = await make(f).join({ email: '  ada@example.com ' })
  assert.deepEqual(r, { ok: true, joinedAt: '2026-11-19T20:00:00.000Z' })
  assert.equal(f.calls.length, 1)
  const { url, init } = f.calls[0]
  assert.equal(url, process.env.IV_NEWSLETTER_URL || NEWSLETTER_URL)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['X-IV-App'], 'iv-test')
  assert.equal(init.headers['Content-Type'], 'application/json')
  assert.ok(!Object.keys(init.headers).some((k) => k.toLowerCase() === 'origin'))
  assert.deepEqual(JSON.parse(init.body), { email: 'ada@example.com', source: 'app', app: 'iv-test', app_version: '1.2.3' })
})

test('only the join date is kept, never the address', async () => {
  const store = memory()
  await make(fakeFetch(200, { ok: true }), store).join({ email: 'ada@example.com' })
  assert.deepEqual(store.peek(), { joinedAt: '2026-11-19T20:00:00.000Z', cardClosedAt: null })
  assert.ok(!JSON.stringify(store.peek()).includes('ada'))
})

test('a bad address is refused without sending anything', async () => {
  const f = fakeFetch(200, { ok: true })
  for (const email of ['', 'nope', 'a@b', 'a b@c.com', undefined]) assert.equal((await make(f).join({ email })).field, 'email')
  assert.equal(f.calls.length, 0)
})

test('the service saying the address is bad shows on the field', async () => {
  const r = await make(fakeFetch(400, { error: 'Please enter a valid email address.', field: 'email' })).join({ email: 'ada@example.com' })
  assert.deepEqual(r, { ok: false, field: 'email', error: 'Please enter a valid email address.' })
})

test('busy or limited: the service message is shown, nothing is stored', async () => {
  const store = memory()
  for (const status of [429, 503]) {
    const r = await make(fakeFetch(status, { error: 'Try again later.' }), store).join({ email: 'ada@example.com' })
    assert.deepEqual(r, { ok: false, error: 'Try again later.' })
  }
  assert.deepEqual(store.peek(), {})
})

test('refused, broken or unreachable: offers the website instead', async () => {
  for (const f of [fakeFetch(403, { error: 'Forbidden' }), fakeFetch(500, 'oops'), fakeFetch(200, 'not json'), { call: async () => { throw new TypeError('fetch failed') } }]) {
    const r = await make(f).join({ email: 'ada@example.com' })
    assert.equal(r.ok, false); assert.equal(r.offline, true); assert.equal(r.error, "Couldn't reach the signup service.")
  }
})

test('a second click while sending does not send twice', async () => {
  let release
  const f = { calls: 0, call: () => { f.calls++; return new Promise((res) => { release = () => res(new Response('{"ok":true}', { status: 200 })) }) } }
  const n = make(f)
  const first = n.join({ email: 'ada@example.com' })
  assert.equal((await n.join({ email: 'ada@example.com' })).ok, false)
  release()
  assert.equal((await first).ok, true)
  assert.equal(f.calls, 1)
})

test('"Not now" on the first-run card is remembered', () => {
  const store = memory()
  const n = make(fakeFetch(200, {}), store)
  assert.deepEqual(n.status(), { joinedAt: null, cardClosedAt: null, page: NEWSLETTER_PAGE })
  n.closeCard()
  assert.equal(n.status().cardClosedAt, '2026-11-19T20:00:00.000Z')
})

test('IV_NEWSLETTER_URL points test copies at a stand-in', async () => {
  const before = process.env.IV_NEWSLETTER_URL
  process.env.IV_NEWSLETTER_URL = 'http://127.0.0.1:4291/iv-newsletter'
  try {
    const f = fakeFetch(200, { ok: true })
    await make(f).join({ email: 'ada@example.com' })
    assert.equal(f.calls[0].url, 'http://127.0.0.1:4291/iv-newsletter')
  } finally { if (before === undefined) delete process.env.IV_NEWSLETTER_URL; else process.env.IV_NEWSLETTER_URL = before }
})

test('file store: survives a restart, shrugs off a broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivnl-'))
  try {
    const path = join(dir, 'sub', 'newsletter.json')
    fileStore(path).set({ joinedAt: 'x', cardClosedAt: null })
    assert.equal(fileStore(path).get().joinedAt, 'x')
    writeFileSync(path, '{broken')
    assert.deepEqual(fileStore(path).get(), {})
    assert.ok(!readFileSync(path, 'utf8').includes('@'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Electron wiring: four channels, the website opens in the browser', async () => {
  const handlers = {}, opened = []
  registerNewsletter({ handle: (c, fn) => { handlers[c] = fn } }, { openExternal: (u) => { opened.push(u) } }, make(fakeFetch(200, { ok: true })))
  assert.deepEqual(Object.keys(handlers).sort(), ['newsletter:close-card', 'newsletter:join', 'newsletter:open-page', 'newsletter:status'])
  await handlers['newsletter:open-page']()
  assert.deepEqual(opened, [NEWSLETTER_PAGE])
  assert.equal((await handlers['newsletter:join']({}, { email: 'ada@example.com' })).ok, true)
})

// Safeguard (Matthew, 2026-11-19): people's existing data in the apps must never be touched.
const snapshot = (dir) => {
  const out = {}
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[p.slice(dir.length)] = readFileSync(p).toString('base64') } }
  walk(dir)
  return out
}

test('existing data: every other file in the folder stays byte-for-byte the same', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivnl-data-'))
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ signedIn: true, theme: 'dark' }))
    writeFileSync(join(dir, 'Cookies'), Buffer.from([0, 1, 2, 3, 255]))
    mkdirSync(join(dir, 'projects', 'p1'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'p1', 'project.json'), '{"name":"My film"}')
    const before = snapshot(dir)
    const n = make(fakeFetch(200, { ok: true }), fileStore(join(dir, 'newsletter.json')))
    n.status(); await n.join({ email: 'ada@example.com' }); n.closeCard(); n.status()
    await make({ call: async () => { throw new Error('offline') } }, fileStore(join(dir, 'newsletter.json'))).join({ email: 'ada@example.com' })
    const after = snapshot(dir)
    const added = Object.keys(after).filter((k) => !(k in before))
    assert.deepEqual(added.map((k) => k.replace(/^[\\/]+/, '')), ['newsletter.json'])
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], k)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('existing data: the store refuses to write any file but newsletter.json', () => {
  for (const name of ['settings.json', 'Cookies', 'newsletter.json.bak', 'data/../settings.json']) assert.throws(() => fileStore(join(tmpdir(), name)), /only writes newsletter.json/)
})

test('a failed save never breaks the join', async () => {
  const broken = { get: () => ({}), set: () => { throw new Error('disk full') } }
  const r = await make(fakeFetch(200, { ok: true }), broken).join({ email: 'ada@example.com' })
  assert.equal(r.ok, true)
  assert.doesNotThrow(() => make(fakeFetch(200, {}), broken).closeCard())
})
