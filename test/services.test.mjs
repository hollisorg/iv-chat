import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SERVICES,
  approxTime,
  chromeUserAgent,
  hostAllowed,
  popupAllowed,
  latestAcross,
  parseUnread,
  sanitizeChats,
  totalUnread
} from '../src/main/services.js'

// Thursday 29 October 2026, 2:00 PM local time.
const NOW = new Date(2026, 9, 29, 14, 0, 0)
const HOUR = 3600e3

test('approxTime reads WhatsApp and Facebook time labels', () => {
  assert.equal(approxTime('7:46 AM', NOW), new Date(2026, 9, 29, 7, 46).getTime())
  assert.equal(approxTime('12:05 PM', NOW), new Date(2026, 9, 29, 12, 5).getTime())
  assert.equal(approxTime('12:05 AM', NOW), new Date(2026, 9, 29, 0, 5).getTime())
  assert.equal(approxTime('19:30', NOW), new Date(2026, 9, 29, 19, 30).getTime())
  assert.equal(approxTime('Yesterday', NOW), NOW.getTime() - 24 * HOUR)
  assert.equal(approxTime('Tuesday', NOW), NOW.getTime() - 2 * 24 * HOUR)
  assert.equal(approxTime('Thursday', NOW), NOW.getTime() - 7 * 24 * HOUR)
  assert.equal(approxTime('10/20/2026', NOW), new Date(2026, 9, 20, 12).getTime())
  assert.equal(approxTime('48 minutes ago', NOW), NOW.getTime() - 48 * 60e3)
  assert.equal(approxTime('a day ago', NOW), NOW.getTime() - 24 * HOUR)
  assert.equal(approxTime('6h', NOW), NOW.getTime() - 6 * HOUR)
  assert.equal(approxTime('something else', NOW), null)
  assert.equal(approxTime('', NOW), null)
})

test('latestAcross mixes services newest first and keeps unknown times last', () => {
  const list = latestAcross(
    {
      whatsapp: [
        { name: 'A', time: '1:00 PM' },
        { name: 'B', time: 'Yesterday' },
        { name: 'C', time: '???' }
      ],
      messenger: [
        { name: 'D', time: '10 minutes ago' },
        { name: 'E', time: '3 hours ago' }
      ]
    },
    NOW
  )
  assert.deepEqual(
    list.map((c) => c.name),
    ['D', 'A', 'E', 'B', 'C']
  )
  assert.equal(list[0].service, 'messenger')
})

test('sanitizeChats keeps only bounded plain fields from the page', () => {
  const out = sanitizeChats({
    status: 'ok',
    chats: [
      { name: '  Sam  ', preview: 'hi\nthere', time: '7:46 AM', unread: 3, html: '<b>x</b>' },
      { name: '', preview: 'no name' },
      { name: 'x'.repeat(500), preview: 'y'.repeat(1000), unread: -2 }
    ]
  })
  assert.equal(out.status, 'ok')
  assert.deepEqual(out.chats[0], { id: '', name: 'Sam', preview: 'hi there', time: '7:46 AM', unread: 3 })
  assert.equal(sanitizeChats({ status: 'ok', chats: [{ id: '1234567890', name: 'a' }] }).chats[0].id, '1234567890')
  assert.equal(sanitizeChats({ status: 'ok', chats: [{ id: '../x y', name: 'a' }] }).chats[0].id, '')
  assert.equal(out.chats.length, 2)
  assert.equal(out.chats[1].name.length, 120)
  assert.equal(out.chats[1].preview.length, 300)
  assert.equal(out.chats[1].unread, 0)
  assert.equal(sanitizeChats({ status: 'ok', chats: [{ name: '' }] }).status, 'unreadable')
  assert.equal(sanitizeChats({ status: 'evil' }).status, 'unreadable')
  assert.equal(sanitizeChats({ status: 'ok', chats: Array(50).fill({ name: 'n' }) }).chats.length, 20)
})

test('parseUnread reads the leading count in a tab title', () => {
  assert.equal(parseUnread('(3) WhatsApp'), 3)
  assert.equal(parseUnread('(12) Messenger | Facebook'), 12)
  assert.equal(parseUnread('(99+) Facebook'), 99)
  assert.equal(parseUnread('WhatsApp'), 0)
  assert.equal(parseUnread('Chats (4)'), 0)
  assert.equal(parseUnread(''), 0)
  assert.equal(parseUnread(undefined), 0)
})

test('hostAllowed keeps each panel on its own domains over https', () => {
  const wa = SERVICES.whatsapp
  const fb = SERVICES.messenger
  assert.ok(hostAllowed(wa, 'https://web.whatsapp.com/'))
  assert.ok(hostAllowed(wa, 'https://mmg.whatsapp.net/x'))
  assert.ok(!hostAllowed(wa, 'https://evilwhatsapp.com/'))
  assert.ok(!hostAllowed(wa, 'http://web.whatsapp.com/'))
  assert.ok(!hostAllowed(wa, 'https://www.facebook.com/'))
  assert.ok(hostAllowed(fb, 'https://www.facebook.com/messages/'))
  assert.ok(hostAllowed(fb, 'https://m.facebook.com/checkpoint/'))
  assert.ok(hostAllowed(fb, 'https://www.messenger.com/'))
  assert.ok(hostAllowed(fb, 'https://auth.meta.com/'))
  assert.ok(!hostAllowed(fb, 'https://facebook.com.example.org/'))
  assert.ok(!hostAllowed(fb, 'https://example.com/'))
  assert.ok(!hostAllowed(fb, 'not a url'))
})

test('chromeUserAgent drops the Electron and app tokens only', () => {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) iv-chat/0.1.0 Chrome/146.0.7680.0 Electron/44.9.0 Safari/537.36'
  assert.equal(
    chromeUserAgent(ua),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Safari/537.36'
  )
})

test('totalUnread only counts services that are on', () => {
  assert.equal(
    totalUnread({ whatsapp: { enabled: true, unread: 2 }, messenger: { enabled: false, unread: 5 } }),
    2
  )
})

import { flattenDraft, mediaLabel, parsePrePlain } from '../src/main/whatsapp-parse.js'

test('WhatsApp helpers: message labels, one-paragraph drafts, media names', () => {
  assert.deepEqual(parsePrePlain('[8:11 AM, 10/29/2026] Sam Lee: '), { time: '8:11 AM', date: '10/29/2026', from: 'Sam Lee' })
  assert.deepEqual(parsePrePlain('[19:05, 29/10/2026] +1 555 0100: '), { time: '19:05', date: '29/10/2026', from: '+1 555 0100' })
  assert.equal(parsePrePlain('nonsense'), null)
  assert.equal(flattenDraft('Hi Jo,\n\nSee you at 7.\r\nThanks'), 'Hi Jo, See you at 7. Thanks')
  assert.ok(!flattenDraft('a\nb\rc').includes('\n'))
  assert.equal(mediaLabel(['author', 'image-thumb']), '[Photo]')
  assert.equal(mediaLabel(['audio-play']), '[Voice message]')
  assert.equal(mediaLabel([]), '[Media]')
})

import { cleanPrefs, starterMessage } from '../src/main/starter.js'

test('starter message carries the reply preferences and the no-send rule', () => {
  const msg = starterMessage('codex', { tone: 'professional', length: 'match', signOff: 'Matt', notes: 'No emojis with clients' })
  assert.match(msg, /clear and professional/)
  assert.match(msg, /Match the length/)
  assert.match(msg, /Sign off as "Matt"/)
  assert.match(msg, /No emojis with clients/)
  assert.match(msg, /Never say a message was sent/)
  assert.match(msg, /get_updates/)
  assert.doesNotMatch(starterMessage('claude', {}), /Sign off as/)
  assert.deepEqual(cleanPrefs({ tone: 'rude', length: 'epic', signOff: 5 }), { tone: 'friendly', length: 'short', signOff: '5', notes: '' })
})

import { decodeWaveform, waveformBars } from '../src/main/waveform.js'

test('Telegram waveforms: 5-bit values unpack and shrink to bars', () => {
  // Values 31, 0, 31, 0 ... packed 5 bits each, little-endian.
  const values = [31, 0, 31, 0, 31, 0, 31, 0]
  let bits = 0n
  values.forEach((v, i) => (bits |= BigInt(v) << BigInt(i * 5)))
  const bytes = Array.from({ length: 5 }, (_, i) => Number((bits >> BigInt(i * 8)) & 255n))
  assert.deepEqual(decodeWaveform(bytes), values)
  assert.deepEqual(decodeWaveform(null), [])
  const bars = waveformBars(values, 4)
  assert.equal(bars.length, 4)
  assert.ok(bars.every((b) => b === 1))
  const made = waveformBars([], 10, 42)
  assert.equal(made.length, 10)
  assert.ok(made.every((b) => b >= 0.25 && b <= 0.75))
  assert.deepEqual(made, waveformBars([], 10, 42))
})

test('popupAllowed keeps sign-in pop-ups in the panel and sends other links out', () => {
  const li = SERVICES.linkedin
  assert.ok(popupAllowed(li, 'about:blank'))
  assert.ok(popupAllowed(li, ''))
  assert.ok(popupAllowed(li, 'https://www.linkedin.com/uas/login'))
  assert.ok(popupAllowed(li, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'))
  assert.ok(popupAllowed(li, 'https://appleid.apple.com/auth/authorize'))
  assert.ok(popupAllowed(li, 'https://login.microsoftonline.com/common/oauth2'))
  assert.ok(!popupAllowed(li, 'https://example.com/article'))
  assert.ok(!popupAllowed(li, 'http://accounts.google.com/'))
  assert.ok(!popupAllowed(li, 'https://accounts.google.com.evil.com/'))
})
