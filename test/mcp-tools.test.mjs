import test from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter, aiCanSee, cleanAi, setChatAccess } from '../src/main/ai-access.js'
import { createTools } from '../src/main/mcp-tools.js'

const NOW = new Date(2026, 9, 29, 14, 0).getTime()

function fakeTelegram() {
  return {
    status: 'ready',
    drafts: [],
    sent: [],
    dialogList: () => [
      { id: '111', name: 'Sam', unread: 2, preview: 'are we still on?', at: NOW - 60e3 },
      { id: '222', name: 'Family', unread: 0, preview: 'ok', at: NOW - 86400e3 }
    ],
    updates: [
      { chat_id: '111', id: 9, from: 'Sam', text: 'are we still on?', at: NOW - 60e3 },
      { chat_id: '222', id: 3, from: 'Mum', text: 'ok', at: NOW - 50e3 }
    ],
    async messages(id) {
      return [{ id: 1, from: 'Sam', text: `hello from ${id}`, at: NOW - 1000, outgoing: false }]
    },
    async search() {
      return [
        { chat_id: '111', id: 1, from: 'Sam', text: 'dinner', at: NOW },
        { chat_id: '222', id: 2, from: 'Mum', text: 'dinner?', at: NOW }
      ]
    },
    async saveDraft(id, text) {
      this.drafts.push({ id, text })
    }
  }
}

const web = {
  whatsapp: { status: 'ok', chats: [{ id: '', name: 'Jo', preview: 'see you', time: '1:30 PM', unread: 1 }] },
  messenger: { status: 'ok', chats: [{ id: '5551', name: 'Lee', preview: 'thanks!', time: '3 hours ago', unread: 0 }] }
}

function fakeWhatsApp() {
  return {
    opened: [],
    drafts: [],
    ready: () => true,
    async read(name, limit) {
      this.opened.push(name)
      return { chat: name, messages: [{ from: 'Jo', text: 'see you', time: '10/29/2026 1:30 PM', outgoing: false }].slice(0, limit) }
    },
    async draft(name, text) {
      this.drafts.push({ name, text })
      return { placed: text.replace(/\n+/g, ' ') }
    }
  }
}

function setup(ai, { withWhatsApp = false } = {}) {
  const telegram = fakeTelegram()
  const whatsapp = withWhatsApp ? fakeWhatsApp() : undefined
  const log = []
  const placed = []
  let settings = cleanAi(ai)
  const call = createTools({
    telegram,
    whatsapp,
    getWebChats: () => web,
    getAi: () => settings,
    limiter: new RateLimiter({ calls: { max: 60, windowMs: 60e3 }, drafts: { max: 2, windowMs: 3600e3 } }, () => NOW),
    log: (e) => log.push(e),
    onDraft: (key, text) => placed.push({ key, text }),
    now: () => NOW
  })
  return { call, telegram, whatsapp, log, placed, set: (next) => (settings = cleanAi(next)) }
}

test('access rules: chosen mode only shows switched-on chats; all mode hides excluded ones', () => {
  let ai = cleanAi({ mode: 'chosen' })
  assert.equal(aiCanSee(ai, 'telegram:111'), false)
  ai = setChatAccess(ai, 'telegram:111', true)
  assert.equal(aiCanSee(ai, 'telegram:111'), true)
  ai = { ...setChatAccess({ ...ai, mode: 'all' }, 'telegram:222', false) }
  assert.equal(aiCanSee(ai, 'whatsapp:Jo'), true)
  assert.equal(aiCanSee(ai, 'telegram:222'), false)
  assert.equal(aiCanSee({ ...ai, enabled: false }, 'whatsapp:Jo'), false)
  assert.deepEqual(cleanAi({ mode: 'weird', allowed: ['ok:1', 5, 'nocolon'] }), { enabled: true, mode: 'chosen', allowed: ['ok:1'], excluded: [] })
})

test('nothing is visible until the person chooses chats', async () => {
  const { call } = setup({ mode: 'chosen' })
  const res = await call('list_chats', {})
  assert.deepEqual(res.chats, [])
  assert.match(res.note, /chooses them in IV Chat/)
})

test('list_chats returns only allowed chats across services, newest first', async () => {
  const { call } = setup({ mode: 'chosen', allowed: ['telegram:111', 'whatsapp:Jo', 'messenger:5551'] })
  const { chats } = await call('list_chats', {})
  assert.deepEqual(
    chats.map((c) => c.chat_id),
    ['telegram:111', 'whatsapp:Jo', 'messenger:5551']
  )
})

test('read_chat refuses chats the AI cannot see, and reads allowed Telegram chats', async () => {
  const { call, log } = setup({ mode: 'chosen', allowed: ['telegram:111'] })
  assert.match((await call('read_chat', { chat_id: 'telegram:222' })).error, /not allowed|allowed to see/)
  const ok = await call('read_chat', { chat_id: 'telegram:111' })
  assert.equal(ok.messages[0].text, 'hello from 111')
  assert.equal(log.at(-1).ok, true)
  assert.equal(log.at(-2).ok, false)
})

test('get_updates reports only allowed news, then only what changed', async () => {
  const { call } = setup({ mode: 'all', excluded: ['telegram:222'] })
  const first = await call('get_updates')
  assert.ok(first.chats_with_news.some((c) => c.chat_id === 'telegram:111'))
  assert.ok(!first.chats_with_news.some((c) => c.chat_id === 'telegram:222'))
  assert.deepEqual(
    first.new_telegram_messages.map((m) => m.chat_id),
    ['telegram:111']
  )
  const second = await call('get_updates')
  assert.deepEqual(second.chats_with_news, [])
  assert.deepEqual(second.new_telegram_messages, [])
})

test('search only returns allowed chats', async () => {
  const { call } = setup({ mode: 'chosen', allowed: ['telegram:111'] })
  const { results } = await call('search_messages', { query: 'dinner' })
  assert.deepEqual(
    results.map((r) => r.chat_id),
    ['telegram:111']
  )
})

test('draft_reply saves a Telegram draft and never sends; limits apply', async () => {
  const { call, telegram, placed } = setup({ mode: 'all' })
  const res = await call('draft_reply', { chat_id: 'telegram:111', text: 'Yes, 7pm works!' })
  assert.equal(res.status, 'draft placed')
  assert.deepEqual(telegram.drafts, [{ id: '111', text: 'Yes, 7pm works!' }])
  assert.deepEqual(placed, [{ key: 'telegram:111', text: 'Yes, 7pm works!' }])
  assert.deepEqual(telegram.sent, [])
  assert.match((await call('draft_reply', { chat_id: 'whatsapp:Jo', text: 'hi' })).error, /not signed in/)
  assert.match((await call('draft_reply', { chat_id: 'messenger:5551', text: 'hi' })).error, /later IV Chat update/)
  await call('draft_reply', { chat_id: 'telegram:111', text: 'two' })
  assert.match((await call('draft_reply', { chat_id: 'telegram:111', text: 'three' })).error, /Draft limit/)
})

test('there is no send tool, and turning AI access off stops everything', async () => {
  const { call, set } = setup({ mode: 'all' })
  assert.match((await call('send_message', { chat_id: 'telegram:111', text: 'x' })).error, /Unknown tool/)
  set({ mode: 'all', enabled: false })
  assert.match((await call('list_chats', {})).error, /turned off AI access/)
})

test('WhatsApp: read_chat opens and reads the chat; draft_reply places a draft and never sends', async () => {
  const { call, whatsapp, placed } = setup({ mode: 'chosen', allowed: ['whatsapp:Jo'] }, { withWhatsApp: true })
  const read = await call('read_chat', { chat_id: 'whatsapp:Jo' })
  assert.deepEqual(whatsapp.opened, ['Jo'])
  assert.equal(read.messages[0].text, 'see you')
  assert.match(read.note, /marks it as read/)
  const twoLines = ['On my way!', 'See you soon'].join(String.fromCharCode(10))
  const res = await call('draft_reply', { chat_id: 'whatsapp:Jo', text: twoLines })
  assert.equal(res.status, 'draft placed')
  assert.deepEqual(whatsapp.drafts, [{ name: 'Jo', text: twoLines }])
  assert.deepEqual(placed, [{ key: 'whatsapp:Jo', text: 'On my way! See you soon' }])
  assert.match(res.note, /Nothing was sent/)
  // A WhatsApp chat that isn't shared stays off limits.
  assert.match((await call('read_chat', { chat_id: 'whatsapp:Someone' })).error, /allowed to see/)
})
