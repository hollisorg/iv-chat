// Runs in each website panel (WhatsApp, Messenger, Instagram, LinkedIn), before the site's own scripts.
//
// 1. Passkey guard: a sign-in page that asks Windows for a passkey on its own, before you've clicked
//    anything, is quietly told "not now", so opening IV Chat doesn't pop up "Choose a passkey".
// 2. Chat list reader (read-only): every few seconds, reads the top of the chat list that's already
//    on screen (name, last message, time, unread count) for IV Chat's Updates page. It never clicks,
//    types, scrolls or sends, and only runs while "Show latest messages" is on in Settings.
// 3. Device choice: the microphone, camera and speaker picked in Settings > Calls and devices (device-choice.js).
import { contextBridge, ipcRenderer } from 'electron'
import { flattenDraft, mediaLabel, parsePrePlain } from '../main/whatsapp-parse.js'
import { installDeviceChoice } from '../main/device-choice.js'

contextBridge.executeInMainWorld({
  func: () => {
    const creds = navigator.credentials
    if (!creds || typeof creds.get !== 'function') return
    const original = creds.get.bind(creds)
    creds.get = function get(options) {
      const passkey = options && options.publicKey
      const clicked = navigator.userActivation && navigator.userActivation.isActive
      if (!passkey || clicked) return original(options)
      // Autofill-style requests normally wait for the person; leave them waiting.
      if (options.mediation === 'conditional') return new Promise(() => {})
      return Promise.reject(new DOMException('The request is not allowed.', 'NotAllowedError'))
    }
  }
})

// ---------- device choice ----------

// A fresh name each page load for the hidden setter that passes new choices into the page.
const DEVICE_KEY = `__iv_${Math.random().toString(36).slice(2)}`
contextBridge.executeInMainWorld({ func: installDeviceChoice, args: [DEVICE_KEY, ipcRenderer.sendSync('panel:media')] })
ipcRenderer.on('media:set', (_e, wanted) => {
  contextBridge.executeInMainWorld({ func: (key, w) => window[key]?.(w), args: [DEVICE_KEY, wanted] })
})

// ---------- chat list reader ----------

const MAX_CHATS = 15
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')

// Selectors are kept to the sites' own test ids, roles and labels, which change less than layout classes.
// If a site changes and these stop matching, the reader reports "unreadable" instead of guessing.
const READERS = {
  'web.whatsapp.com': () => {
    const list = document.querySelector('[aria-label="Chat list"]')
    if (!list) return { status: 'no-list', chats: [] }
    const rows = [...list.querySelectorAll('[role="row"]')]
    const chats = rows.map((row) => {
      const title = row.querySelector('[data-testid="cell-frame-title"] span[title]')
      const last = row.querySelector('[data-testid="last-msg-status"]')
      const badge = [...row.querySelectorAll('[aria-label]')].find((e) => /^\d+ unread message/i.test(e.getAttribute('aria-label')))
      return {
        name: title ? title.getAttribute('title') || text(title) : '',
        preview: last ? last.getAttribute('title') || text(last) : '',
        time: text(row.querySelector('[data-testid="chat-list-timestamp"]')),
        unread: badge ? parseInt(badge.getAttribute('aria-label'), 10) : 0
      }
    })
    return { status: 'ok', chats }
  },
  'www.facebook.com': () => {
    if (!location.pathname.startsWith('/messages')) return { status: 'no-list', chats: [] }
    const grid = document.querySelector('[role="navigation"] [role="grid"]')
    if (!grid) return { status: 'no-list', chats: [] }
    const rows = [...grid.querySelectorAll('[role="row"]')].filter((r) => r.querySelector('a[href*="/messages/t/"]'))
    const chats = rows.map((row) => {
      const link = row.querySelector('a[href*="/messages/t/"]')
      const parts = [...link.querySelectorAll('span[dir="auto"]')]
      const name = text(parts[0])
      // The preview is the first later text that isn't the name, the "·" divider or the time.
      const preview = parts.slice(1).map(text).find((t) => t && t !== '·' && t !== name && !parts.some((p) => p.querySelector('abbr') && text(p) === t))
      const abbr = row.querySelector('abbr')
      const id = (/\/messages\/t\/([\w.-]+)/.exec(link.getAttribute('href') || '') || [])[1] || ''
      return { id, name, preview: preview || '', time: abbr ? abbr.getAttribute('aria-label') || text(abbr) : '', unread: 0 }
    })
    return { status: 'ok', chats }
  }
}

let enabled = false
let lastSent = ''

function read() {
  if (!enabled) return
  const reader = READERS[location.hostname]
  if (!reader) return
  let result
  try {
    result = reader()
  } catch {
    result = { status: 'unreadable', chats: [] }
  }
  result.chats = result.chats.slice(0, MAX_CHATS)
  const json = JSON.stringify(result)
  if (json === lastSent) return
  lastSent = json
  ipcRenderer.send('panel:chats', result)
}

ipcRenderer.on('reader:set', (_e, on) => {
  enabled = Boolean(on)
  lastSent = ''
  if (enabled) read()
})

setInterval(read, 3000)

// ---------- WhatsApp assisted mode ----------
// Three actions IV Chat's main process can ask for, only on web.whatsapp.com:
//   open:  click a chat in the visible chat list (the panel visibly switches to it)
//   read:  read the messages of the open chat that WhatsApp has loaded
//   draft: put text into the reply box
// None of them ever sends: nothing here presses Enter or clicks Send.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const openTitle = () => text(document.querySelector('#main [data-testid="conversation-info-header-chat-title"]'))

function chatRow(name) {
  const rows = [...document.querySelectorAll('[aria-label="Chat list"] [role="row"]')]
  return rows.find((row) => {
    const t = row.querySelector('[data-testid="cell-frame-title"] span[title]')
    return t && (t.getAttribute('title') || text(t)) === name
  })
}

const WA = {
  async open({ name }) {
    if (openTitle() === name) return { opened: name }
    const row = chatRow(name)
    if (!row) throw new Error('That chat is not in the visible WhatsApp chat list. Scroll to it in WhatsApp or open it there first.')
    const target = row.querySelector('[data-testid="cell-frame-container"]') || row
    for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    for (let i = 0; i < 40; i++) {
      await sleep(100)
      if (openTitle() === name) return { opened: name }
    }
    throw new Error('WhatsApp did not open that chat.')
  },

  async read({ limit = 30 }) {
    const main = document.querySelector('#main')
    if (!main) throw new Error('No WhatsApp chat is open.')
    // Wait until the panel has its real size and the message list has stopped growing.
    for (let i = 0; i < 30 && innerHeight < 200; i++) await sleep(100)
    const count = () => main.querySelectorAll('[data-testid^="conv-msg-"]').length
    let last = -1
    for (let i = 0; i < 30; i++) {
      const n = count()
      if (n > 0 && n === last) break
      last = n
      await sleep(150)
    }
    // WhatsApp keeps empty placeholders for messages away from the screen; only real bubbles are read.
    const msgs = [...main.querySelectorAll('[data-testid^="conv-msg-"]')].filter((m) => m.querySelector('[data-testid="msg-container"]'))
    let lastFrom = ''
    let lastDate = ''
    // Media messages carry no label, but every bubble shows its time somewhere in its own text.
    const timeIn = (m) => [...m.querySelectorAll('span')].map(text).find((t) => /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(t)) || ''
    const out = msgs.map((m) => {
      const pre = m.querySelector('[data-pre-plain-text]')
      const meta = pre ? parsePrePlain(pre.getAttribute('data-pre-plain-text')) : null
      const outgoing = Boolean(m.querySelector('[data-testid="tail-out"], [data-icon="tail-out"], [data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"]'))
      const kinds = [...m.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
      const author = text(m.querySelector('[data-testid="author"]'))
      const body = text(m.querySelector('span.selectable-text'))
      if (meta?.from) lastFrom = meta.from
      else if (author) lastFrom = author
      if (meta?.date) lastDate = meta.date
      const time = meta?.time || timeIn(m)
      return {
        from: outgoing ? 'You' : meta?.from || author || lastFrom,
        text: body || mediaLabel(kinds),
        time: [lastDate, time].filter(Boolean).join(' '),
        outgoing
      }
    })
    return { chat: openTitle(), height: innerHeight, messages: out.slice(-Math.min(Math.max(1, limit), 60)) }
  },

  async draft({ text: body }) {
    return placeDraft(document.querySelector('#main footer [contenteditable="true"][role="textbox"]'), body)
  }
}

// Facebook Messages, Instagram Direct and LinkedIn Messaging: read the open conversation and place a draft.
// Each reader only looks at what the site has already put on screen; none of them clicks or scrolls.
const replyBox = () =>
  [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"].msg-form__contenteditable')].find((b) => b.offsetParent !== null)
const lastN = (list, limit) => list.slice(-Math.min(Math.max(1, limit), 60))

// Messenger labels every message for screen readers: "At 3:05 PM, Sam: see you then" ("You:" for your own).
const SITE_FACEBOOK = {
  async read({ limit = 30 }) {
    const log = document.querySelector('[role="log"]')
    if (!log) throw new Error('No Messenger chat is open.')
    const chat = (log.getAttribute('aria-label') || '').replace(/^Messages in conversation with\s*/i, '').trim()
    const messages = [...log.querySelectorAll('[role="article"]')]
      .map((a) => {
        const label = a.getAttribute('aria-label') || a.querySelector('[data-scope="messages_table"]')?.getAttribute('aria-label') || ''
        const m = /^At (.+?), (.+?): ([\s\S]*)$/.exec(label)
        if (!m) return null
        const outgoing = m[2] === 'You'
        return { from: outgoing ? 'You' : m[2], text: m[3].trim() || '[Attachment]', time: m[1], outgoing }
      })
      .filter(Boolean)
    return { chat, messages: lastN(messages, limit) }
  },
  draft: ({ text: body }) => placeDraft(replyBox(), body)
}

// Instagram marks each message as role="article"; your own sit on the right, theirs on the left.
// Date and time dividers between them are carried onto the messages that follow.
const SITE_INSTAGRAM = {
  async read({ limit = 30 }) {
    const box = replyBox()
    if (!box || !location.pathname.startsWith('/direct/t/')) throw new Error('No Instagram chat is open.')
    let col = box
    while (col.parentElement && col.getBoundingClientRect().height < 400) col = col.parentElement
    const cr = col.getBoundingClientRect()
    const isLeaf = (l) => !l.querySelector('[dir="auto"]') && text(l)
    const bubbleOf = (el) => {
      for (let i = 0; i < 10 && el && el !== col; i++, el = el.parentElement) {
        const c = getComputedStyle(el).backgroundColor
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return el
      }
      return null
    }
    const header = [...document.querySelectorAll('h2')].find((h) => {
      const r = h.getBoundingClientRect()
      return r.width > 0 && r.top < 90 && r.left >= cr.left - 10
    })
    const chat = text(header)
    const messages = []
    let when = ''
    for (const el of col.querySelectorAll('[role="article"][aria-roledescription="message"], div[dir="auto"], span[dir="auto"]')) {
      if (el.matches('[role="article"]')) {
        const leaves = [...el.querySelectorAll('div[dir="auto"], span[dir="auto"]')].filter(isLeaf)
        const leaf = leaves[leaves.length - 1]
        const r = (bubbleOf(leaf || el) || el).getBoundingClientRect()
        const outgoing = cr.right - r.right < r.left - cr.left
        messages.push({ from: outgoing ? 'You' : chat, text: leaf ? text(leaf) : '[Attachment]', time: when, outgoing })
      } else if (!el.closest('[role="article"]') && isLeaf(el) && !box.contains(el) && el.getBoundingClientRect().top > cr.top + 70 && text(el).length < 40) {
        when = text(el)
      }
    }
    return { chat, messages: lastN(messages, limit) }
  },
  draft: ({ text: body }) => placeDraft(replyBox(), body)
}

// LinkedIn groups messages under the sender's name; messages from others carry the "--other" marker.
// Not yet checked against a signed-in LinkedIn account.
const SITE_LINKEDIN = {
  async read({ limit = 30 }) {
    const list = document.querySelector('.msg-s-message-list, .msg-s-message-list-content')
    if (!list) throw new Error('No LinkedIn chat is open.')
    const chat = text(document.querySelector('.msg-entity-lockup__entity-title, .msg-thread__link-to-profile, .msg-overlay-bubble-header__title'))
    let from = ''
    let when = ''
    const messages = [...list.querySelectorAll('.msg-s-event-listitem')].map((item) => {
      const group = item.closest('.msg-s-message-list__event') || item
      const name = text(group.querySelector('.msg-s-message-group__name'))
      const time = text(group.querySelector('.msg-s-message-group__timestamp, time'))
      if (name) from = name
      if (time) when = time
      const outgoing = !item.classList.contains('msg-s-event-listitem--other')
      return { from: outgoing ? 'You' : from || chat, text: text(item.querySelector('.msg-s-event-listitem__body')) || '[Attachment]', time: when, outgoing }
    })
    return { chat, messages: lastN(messages, limit) }
  },
  draft: ({ text: body }) => placeDraft(replyBox(), body)
}

// Puts text in a site's reply box, replacing what's there, as typing would. No key events are sent and
// nothing presses Enter or Send. Shared by every site.
// Sites update their editors on their own schedule, so the box is watched for a moment before judging.
// If the site ignored the typed-in text (Messenger sometimes does), the same text is offered once more as
// a paste, which these editors also accept.
const boxText = (box) => String(box.value ?? box.innerText ?? '').replace(/\s+/g, ' ').trim()

function selectAllIn(box) {
  box.focus()
  if (typeof box.setSelectionRange === 'function') return box.setSelectionRange(0, box.value.length)
  const range = document.createRange()
  range.selectNodeContents(box)
  const sel = getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

async function settled(box, text) {
  for (let i = 0; i < 12; i++) {
    const now = boxText(box)
    if (now === text) return now
    await sleep(100)
  }
  return boxText(box)
}

async function placeDraft(box, body) {
  if (!box) throw new Error('The reply box was not found. Open a chat first.')
  const text = flattenDraft(body)
  selectAllIn(box)
  document.execCommand('insertText', false, text)
  let now = await settled(box, text)
  if (now !== text) {
    selectAllIn(box)
    const data = new DataTransfer()
    data.setData('text/plain', text)
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    now = await settled(box, text)
  }
  if (now === text) return { placed: true }
  // A site can tidy what it shows (an emoticon drawn as a picture, say); text of about the right
  // length that starts the same way counts as placed.
  if (now && now.slice(0, 10) === text.slice(0, 10) && Math.abs(now.length - text.length) <= Math.max(8, text.length * 0.1)) return { placed: true }
  if (document.activeElement !== box) throw new Error("Couldn't put the draft in the reply box. Close any pop-up in the chat, click its reply box once, then try again.")
  throw new Error("The reply box didn't take the draft. Click in it once, then try again.")
}

// Each site's reader for the open conversation, plus the shared draft step.
const SITES = {
  'web.whatsapp.com': WA,
  'www.facebook.com': SITE_FACEBOOK,
  'www.instagram.com': SITE_INSTAGRAM,
  'www.linkedin.com': SITE_LINKEDIN
}

ipcRenderer.on('assist:run', async (_e, { id, op, args }) => {
  try {
    const site = SITES[location.hostname]
    if (!site || !site[op]) throw new Error('Not available here')
    ipcRenderer.send('assist:reply', { id, ok: true, result: await site[op](args || {}) })
  } catch (err) {
    ipcRenderer.send('assist:reply', { id, ok: false, error: String(err?.message || err) })
  }
})
