import test from 'node:test'
import assert from 'node:assert/strict'
import { actionText, entityHref, entityList, findUrls, formatRuns, linkPreview, mediaInfo, messageText, safeHref, statusText } from '../src/main/tg-format.js'
import { mediaUrl, parseMediaUrl, parseRange } from '../src/main/tg-media.js'

const doc = (attributes, extra = {}) => ({ media: { className: 'MessageMediaDocument', document: { className: 'Document', id: 1, size: 2048, mimeType: 'video/mp4', thumbs: [{}], attributes, ...extra } } })

test('mediaInfo tells GIFs, round videos, videos and stickers apart', () => {
  assert.equal(mediaInfo(doc([{ className: 'DocumentAttributeAnimated' }, { className: 'DocumentAttributeVideo', w: 320, h: 240 }])).kind, 'gif')
  assert.equal(mediaInfo(doc([{ className: 'DocumentAttributeVideo', roundMessage: true, w: 240, h: 240 }])).kind, 'round')
  const video = mediaInfo(doc([{ className: 'DocumentAttributeVideo', w: 1280, h: 720, duration: 61 }]))
  assert.equal(video.kind, 'video')
  assert.equal(video.w, 1280)
  assert.equal(video.duration, 61)
  assert.equal(mediaInfo(doc([{ className: 'DocumentAttributeSticker', alt: '😀' }], { mimeType: 'application/x-tgsticker' })).kind, 'sticker-animated')
  assert.equal(mediaInfo(doc([{ className: 'DocumentAttributeSticker' }], { mimeType: 'video/webm' })).kind, 'sticker-video')
  assert.equal(mediaInfo(doc([{ className: 'DocumentAttributeSticker' }], { mimeType: 'image/webp' })).kind, 'sticker')
  assert.equal(mediaInfo(doc([{ className: 'DocumentAttributeFilename', fileName: 'notes.pdf' }], { mimeType: 'application/pdf' })).kind, 'file')
})

test('a link preview is not treated as an attachment', () => {
  const msg = { message: 'see https://example.com', media: { className: 'MessageMediaWebPage', webpage: { className: 'WebPage', url: 'https://example.com', siteName: 'Example', title: 'Hello', description: 'A page', photo: { className: 'Photo' } } } }
  assert.equal(mediaInfo(msg), null)
  assert.deepEqual(linkPreview(msg), { url: 'https://example.com', site: 'Example', title: 'Hello', description: 'A page', photo: true })
  assert.equal(messageText(msg), 'see https://example.com')
})

test('messageText names what a message carries', () => {
  assert.equal(messageText(doc([{ className: 'DocumentAttributeAnimated' }, { className: 'DocumentAttributeVideo' }])), '[GIF]')
  assert.equal(messageText(doc([{ className: 'DocumentAttributeVideo', roundMessage: true }])), '[Video message]')
  assert.equal(messageText(doc([{ className: 'DocumentAttributeSticker', alt: '🔥' }], { mimeType: 'image/webp' })), '[🔥 Sticker]')
})

test('entityList keeps formatting and links inside the text', () => {
  const msg = {
    message: 'Hi bold link',
    entities: [
      { className: 'MessageEntityBold', offset: 3, length: 4 },
      { className: 'MessageEntityTextUrl', offset: 8, length: 4, url: 'https://iv.ai' },
      { className: 'MessageEntityUnknownThing', offset: 0, length: 2 },
      { className: 'MessageEntityItalic', offset: 50, length: 3 }
    ]
  }
  assert.deepEqual(entityList(msg), [
    { type: 'bold', offset: 3, length: 4 },
    { type: 'text_url', offset: 8, length: 4, url: 'https://iv.ai' }
  ])
})

test('entityHref only opens web, e-mail and t.me addresses', () => {
  assert.equal(entityHref({ type: 'url' }, 'example.com/x'), 'https://example.com/x')
  assert.equal(entityHref({ type: 'url' }, 'https://example.com'), 'https://example.com/')
  assert.equal(entityHref({ type: 'text_url', url: 'javascript:alert(1)' }, 'click'), null)
  assert.equal(entityHref({ type: 'text_url', url: 'file:///C:/x' }, 'x'), null)
  assert.equal(entityHref({ type: 'email' }, 'sam@example.com'), 'mailto:sam@example.com')
  assert.equal(entityHref({ type: 'mention' }, '@durov'), 'https://t.me/durov')
  assert.equal(entityHref({ type: 'bold' }, 'x'), null)
  assert.equal(safeHref('tg://resolve?domain=x'), 'tg://resolve?domain=x')
})

test('formatRuns splits text where formatting changes and gives links their whole address', () => {
  const runs = formatRuns('go to example.com now', [
    { type: 'url', offset: 6, length: 11 },
    { type: 'bold', offset: 6, length: 7 }
  ])
  assert.deepEqual(
    runs.map((r) => [r.text, r.types.sort().join('+'), r.href]),
    [
      ['go to ', '', null],
      ['example', 'bold+url', 'https://example.com/'],
      ['.com', 'url', 'https://example.com/'],
      [' now', '', null]
    ]
  )
})

test('formatRuns finds plain links when a message has no entities', () => {
  assert.deepEqual(findUrls('look: https://iv.ai/x, ok'), [{ type: 'url', offset: 6, length: 15 }])
  const runs = formatRuns('look: https://iv.ai/x, ok', [])
  assert.equal(runs.find((r) => r.href)?.href, 'https://iv.ai/x')
})

test('statusText and actionText read like Telegram', () => {
  const now = 1_700_000_000_000
  assert.equal(statusText({ className: 'UserStatusOnline' }, now), 'online')
  assert.equal(statusText({ className: 'UserStatusOffline', wasOnline: now / 1000 - 300 }, now), 'last seen 5 minutes ago')
  assert.equal(statusText({ className: 'UserStatusOffline', wasOnline: now / 1000 - 7200 }, now), 'last seen 2 hours ago')
  assert.equal(statusText({ className: 'UserStatusRecently' }, now), 'last seen recently')
  assert.equal(actionText({ className: 'SendMessageTypingAction' }), 'typing')
  assert.equal(actionText({ className: 'SendMessageCancelAction' }), null)
})

test('media addresses and byte ranges for the in-app player', () => {
  assert.equal(mediaUrl('-1001234', 77), 'ivtg://media/-1001234/77')
  assert.deepEqual(parseMediaUrl('ivtg://media/-1001234/77'), { chatId: '-1001234', msgId: 77 })
  assert.equal(parseMediaUrl('ivtg://media/x/notanumber'), null)
  assert.equal(parseMediaUrl('https://media/x/1'), null)
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 })
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.equal(parseRange('bytes=1000-', 1000), null)
  assert.equal(parseRange('', 1000), null)
})

test('the media cache serves byte ranges while a file is still downloading', async () => {
  const { MediaCache } = await import('../src/main/tg-media.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = path.join(os.tmpdir(), `iv-chat-media-test-${process.pid}`)
  const data = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))
  let release
  const gate = new Promise((r) => (release = r))
  const cache = new MediaCache(dir, async () => ({
    size: data.length,
    mime: 'video/mp4',
    download: async (writer) => {
      await writer.write(data.subarray(0, 100))
      await gate
      await writer.write(data.subarray(100))
    }
  }))
  const url = 'ivtg://media/42/7'
  // Only 100 bytes have arrived, but the answer promises the whole range and streams the rest when it comes.
  const early = await cache.respond(new Request(url, { headers: { range: 'bytes=10-' } }))
  assert.equal(early.status, 206)
  assert.equal(early.headers.get('content-range'), 'bytes 10-299/300')
  assert.equal(Number(early.headers.get('content-length')), 290)
  const reader = early.body.getReader()
  const first = await reader.read()
  assert.deepEqual(Buffer.from(first.value), data.subarray(10, 100))
  // A request past what has arrived waits for it.
  const later = cache.respond(new Request(url, { headers: { range: 'bytes=250-299' } }))
  release()
  const chunks = [Buffer.from(first.value)]
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(Buffer.from(r.value))
  assert.deepEqual(Buffer.concat(chunks), data.subarray(10, 300))
  const res = await later
  assert.equal(res.status, 206)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), data.subarray(250, 300))
  // The whole file, once done.
  const whole = await cache.respond(new Request(url))
  assert.equal(whole.status, 200)
  assert.equal(Number(whole.headers.get('content-length')), 300)
  assert.equal((await cache.respond(new Request('ivtg://media/42/x'))).status, 404)
  cache.clear()
})

test('a seek far past the download is read straight from Telegram at that point', async () => {
  const { MediaCache } = await import('../src/main/tg-media.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = path.join(os.tmpdir(), `iv-chat-media-seek-${process.pid}`)
  const size = 8 * 1024 * 1024
  const byteAt = (i) => (i * 7) % 251
  const block = (from, len) => Buffer.from(Array.from({ length: len }, (_, k) => byteAt(from + k)))
  let asked = null
  const cache = new MediaCache(dir, async () => ({
    size,
    mime: 'video/mp4',
    download: async (writer) => {
      await writer.write(block(0, 64 * 1024))
      await new Promise(() => {}) // the in-order download stalls early
    },
    readFrom: async function* (offset) {
      asked = offset
      for (let at = offset; at < size; at += 512 * 1024) yield block(at, Math.min(512 * 1024, size - at))
    }
  }))
  const start = 5 * 1024 * 1024 + 1000
  const res = await cache.respond(new Request('ivtg://media/9/1', { headers: { range: `bytes=${start}-${start + 99}` } }))
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${start + 99}/${size}`)
  assert.equal(asked % (512 * 1024), 0)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), block(start, 100))
  cache.clear()
})
