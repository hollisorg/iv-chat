// Turns a voice recording from the window (WebM holding Opus audio, the only format Chromium records) into
// OGG Opus, the format Telegram needs for a voice message. The Opus audio itself is copied unchanged; only
// the wrapping changes, so there's no re-encoding. Pure, so it's unit tested (test/ogg-opus.test.mjs).

// ---------- reading WebM (EBML) ----------

// An EBML variable-length number: the count of leading zero bits says how many bytes it takes.
function vint(buf, pos, keepMarker) {
  const first = buf[pos]
  if (first === undefined) return null
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8 || pos + len > buf.length) return null
  let value = keepMarker ? first : first & (0xff >> len)
  let allOnes = value === (0xff >> len)
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xff) allOnes = false
  }
  return { value, len, unknown: !keepMarker && allOnes }
}

const SEGMENT = 0x18538067
const CLUSTER = 0x1f43b675
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const BLOCK_GROUP = 0xa0
const CODEC_PRIVATE = 0x63a2
const SIMPLE_BLOCK = 0xa3
const BLOCK = 0xa1
const MASTERS = new Set([SEGMENT, CLUSTER, TRACKS, TRACK_ENTRY, BLOCK_GROUP])

// The Opus header and the Opus packets, in order, from a WebM file with one audio track.
export function readWebmOpus(input) {
  const buf = Uint8Array.from(input)
  let head = null
  const packets = []
  let pos = 0
  while (pos < buf.length) {
    const id = vint(buf, pos, true)
    if (!id) break
    const size = vint(buf, pos + id.len, false)
    if (!size) break
    const body = pos + id.len + size.len
    if (MASTERS.has(id.value)) {
      // Step inside: Segment and Cluster often have an unknown size while recording.
      pos = body
      continue
    }
    if (size.unknown) break
    const end = Math.min(buf.length, body + size.value)
    if (id.value === CODEC_PRIVATE) head = buf.slice(body, end)
    else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      // Track number, a 16-bit time, a flags byte, then the frame (MediaRecorder doesn't use lacing).
      const track = vint(buf, body, false)
      if (track) {
        const start = body + track.len + 3
        const lacing = (buf[body + track.len + 2] >> 1) & 3
        if (lacing === 0 && start < end) packets.push(buf.slice(start, end))
      }
    }
    pos = end
  }
  if (!head || head.length < 19 || String.fromCharCode(...head.slice(0, 8)) !== 'OpusHead') throw new Error('The recording has no Opus audio')
  if (!packets.length) throw new Error('The recording is empty')
  return { head, packets }
}

// How many 48 kHz samples an Opus packet holds, from its first (TOC) byte.
export function opusSamples(packet) {
  const toc = packet[0]
  const config = toc >> 3
  let frameMs
  if (config < 12) frameMs = [10, 20, 40, 60][config % 4]
  else if (config < 16) frameMs = [10, 20][config % 2]
  else frameMs = [2.5, 5, 10, 20][config % 4]
  const code = toc & 3
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2
  return Math.round(frameMs * 48) * frames
}

// ---------- writing OGG ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    table[i] = r >>> 0
  }
  return table
})()

function oggCrc(bytes) {
  let crc = 0
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0
  return crc
}

const SERIAL = 0x49564348 // "IVCH"

function oggPage(packets, { granule, seq, first, last }) {
  const lacing = []
  for (const p of packets) {
    let n = p.length
    while (n >= 255) {
      lacing.push(255)
      n -= 255
    }
    lacing.push(n)
  }
  const dataLen = packets.reduce((s, p) => s + p.length, 0)
  const page = new Uint8Array(27 + lacing.length + dataLen)
  const view = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53], 0) // "OggS"
  page[5] = (first ? 0x02 : 0) | (last ? 0x04 : 0)
  view.setBigUint64(6, BigInt(granule), true)
  view.setUint32(14, SERIAL, true)
  view.setUint32(18, seq, true)
  page[26] = lacing.length
  page.set(lacing, 27)
  let at = 27 + lacing.length
  for (const p of packets) {
    page.set(p, at)
    at += p.length
  }
  view.setUint32(22, oggCrc(page), true)
  return page
}

// The OGG Opus file for a set of packets, plus its length in seconds.
export function writeOggOpus(head, packets) {
  const preSkip = head[10] | (head[11] << 8)
  const vendor = new TextEncoder().encode('IV Chat')
  const tags = new Uint8Array(8 + 4 + vendor.length + 4)
  tags.set(new TextEncoder().encode('OpusTags'), 0)
  new DataView(tags.buffer).setUint32(8, vendor.length, true)
  tags.set(vendor, 12)
  const pages = [oggPage([head], { granule: 0, seq: 0, first: true }), oggPage([tags], { granule: 0, seq: 1 })]
  let samples = 0
  let seq = 2
  // Up to 50 packets a page (each page can describe at most 255 lacing values).
  for (let i = 0; i < packets.length; i += 50) {
    const group = packets.slice(i, i + 50)
    for (const p of group) samples += opusSamples(p)
    pages.push(oggPage(group, { granule: samples + preSkip, seq: seq++, last: i + 50 >= packets.length }))
  }
  const total = pages.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of pages) {
    out.set(p, at)
    at += p.length
  }
  return { ogg: out, seconds: samples / 48000 }
}

export function webmToOgg(webm) {
  const { head, packets } = readWebmOpus(webm)
  return writeOggOpus(head, packets)
}
