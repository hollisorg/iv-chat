// Plays Telegram videos, GIFs, video stickers and full-size photos inside IV Chat without saving them
// anywhere the person sees. Each file downloads once into a private cache folder, in order, and the window's
// <video> or <img> reads it through the ivtg:// scheme while it's still arriving: each request streams its bytes as
// they come in. The cache is cleared when IV Chat starts and kept under a size limit.
import fs from 'node:fs'
import path from 'node:path'

export const SCHEME = 'ivtg'
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024
const WAIT_MS = 60_000
const CHUNK = 512 * 1024
// How far ahead of the download a request has to start before it's read straight from Telegram instead.
const JUMP_BYTES = 3 * 1024 * 1024
const ALIGN = 512 * 1024

// ivtg://media/<chat id>/<message id>
export function mediaUrl(chatId, msgId) {
  return `${SCHEME}://media/${encodeURIComponent(String(chatId))}/${Number(msgId)}`
}

export function parseMediaUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${SCHEME}:` || url.hostname !== 'media') return null
  const [chat, msg] = url.pathname.split('/').filter(Boolean)
  if (!chat || !/^\d+$/.test(msg || '')) return null
  return { chatId: decodeURIComponent(chat), msgId: Number(msg) }
}

// "bytes=100-" or "bytes=100-199" against a file of `size` bytes; null when there's no usable range.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (!m[1] && !m[2])) return null
  let start
  let end
  if (!m[1]) {
    // A suffix range: the last N bytes.
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start > end || start >= size) return null
  return { start, end }
}

export class MediaCache {
  // `open(chatId, msgId)` resolves to { size, mime, download(writer) } for one message's file.
  constructor(dir, open) {
    this.dir = dir
    this.open = open
    this.entries = new Map() // "chat:msg" -> entry
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  }

  async entry(chatId, msgId) {
    const key = `${chatId}:${msgId}`
    const known = this.entries.get(key)
    if (known && !known.failed) {
      known.used = Date.now()
      return known.ready
    }
    const entry = { key, file: path.join(this.dir, `${String(chatId).replace(/[^\w-]/g, '_')}-${msgId}.bin`), written: 0, done: false, failed: null, waiters: new Set(), used: Date.now() }
    this.entries.set(key, entry)
    entry.ready = (async () => {
      const src = await this.open(chatId, msgId)
      entry.size = src.size
      entry.mime = src.mime || 'application/octet-stream'
      entry.readFrom = src.readFrom
      this.trim(entry.size)
      const fd = fs.openSync(entry.file, 'w')
      const wake = () => {
        for (const w of entry.waiters) w()
      }
      const writer = {
        write: async (chunk) => {
          fs.writeSync(fd, chunk)
          entry.written += chunk.length
          wake()
        },
        close: () => {}
      }
      src
        .download(writer)
        .then(() => {
          entry.done = true
          entry.size = entry.written || entry.size
        })
        .catch((err) => {
          entry.failed = err
          this.entries.delete(key)
        })
        .finally(() => {
          try {
            fs.closeSync(fd)
          } catch {
            /* already closed */
          }
          wake()
        })
      return entry
    })()
    entry.ready.catch(() => this.entries.delete(key))
    return entry.ready
  }

  // Waits until byte `upTo` is on disk, the download ends, or it fails.
  waitFor(entry, upTo) {
    if (entry.done || entry.failed || entry.written > upTo) return Promise.resolve()
    return new Promise((resolve) => {
      const check = () => {
        if (entry.done || entry.failed || entry.written > upTo) {
          clearTimeout(timer)
          entry.waiters.delete(check)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        entry.waiters.delete(check)
        resolve()
      }, WAIT_MS)
      entry.waiters.add(check)
    })
  }

  // Answers one ivtg:// request, honouring Range so videos can seek and start before they finish.
  async respond(request) {
    const where = parseMediaUrl(request.url)
    if (!where) return new Response('Not found', { status: 404 })
    let entry
    try {
      entry = await this.entry(where.chatId, where.msgId)
    } catch (err) {
      return new Response(String(err?.message || err), { status: 404 })
    }
    const size = entry.size
    const range = parseRange(request.headers.get('range'), size)
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    if (!size || start > end) return new Response('Nothing to play', { status: 416 })
    // A seek well past what has downloaded is read straight from Telegram at that point, so it starts at once.
    if (range && !entry.done && entry.readFrom && start > entry.written + JUMP_BYTES) return this.direct(entry, start, end)
    // The whole requested range is promised up front, and its bytes are sent as they arrive from Telegram.
    // (Answering with only the part already downloaded makes Chromium's player give up on the file.)
    let pos = start
    const body = new ReadableStream({
      pull: async (controller) => {
        if (pos > end) return controller.close()
        await this.waitFor(entry, pos)
        if (entry.written <= pos) return controller.error(new Error("Couldn't load this from Telegram"))
        const upto = Math.min(end, entry.written - 1, pos + CHUNK - 1)
        const buf = Buffer.alloc(upto - pos + 1)
        const fd = fs.openSync(entry.file, 'r')
        try {
          fs.readSync(fd, buf, 0, buf.length, pos)
        } finally {
          fs.closeSync(fd)
        }
        pos = upto + 1
        entry.used = Date.now()
        controller.enqueue(buf)
      }
    })
    // Only IV Chat's own window can reach this scheme: it's handled on the default session, and every website
    // panel has a separate one. The CORS header lets that window's fetch() read animated stickers.
    const headers = { 'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
    if (!range) return new Response(body, { status: 200, headers })
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` } })
  }

  // Streams bytes start..end straight from Telegram, without the cache. Telegram reads in aligned blocks, so
  // the read starts at the block holding `start` and skips up to it. Stops when the player moves on.
  direct(entry, start, end) {
    const aligned = start - (start % ALIGN)
    let skip = start - aligned
    let pos = start
    let chunks
    const body = new ReadableStream({
      start: () => {
        chunks = entry.readFrom(aligned)[Symbol.asyncIterator]()
      },
      pull: async (controller) => {
        if (pos > end) return controller.close()
        const next = await chunks.next()
        if (next.done) return pos > end ? controller.close() : controller.error(new Error('The file ended early'))
        let buf = Buffer.from(next.value)
        if (skip) {
          buf = buf.subarray(skip)
          skip = 0
        }
        if (buf.length > end - pos + 1) buf = buf.subarray(0, end - pos + 1)
        pos += buf.length
        controller.enqueue(buf)
      },
      cancel: () => chunks?.return?.()
    })
    const headers = { 'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${entry.size}`, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
    return new Response(body, { status: 206, headers })
  }

  // Keeps the cache under its limit by dropping the least recently used finished files.
  trim(incoming) {
    let total = incoming
    for (const e of this.entries.values()) total += e.size || 0
    const finished = [...this.entries.values()].filter((e) => e.done).sort((a, b) => a.used - b.used)
    for (const e of finished) {
      if (total <= MAX_CACHE_BYTES) break
      total -= e.size || 0
      this.entries.delete(e.key)
      fs.rm(e.file, { force: true }, () => {})
    }
  }

  clear() {
    this.entries.clear()
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}
