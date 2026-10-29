import test from 'node:test'
import assert from 'node:assert/strict'
import { opusSamples, readWebmOpus, webmToOgg } from '../src/main/ogg-opus.js'
import { decodeWaveform, encodeWaveform } from '../src/main/waveform.js'

// A tiny WebM like MediaRecorder writes: unknown-size Segment and Cluster, one Opus track, SimpleBlocks.
function el(id, body, unknown = false) {
  const idBytes = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v & 0xff)
  const size = unknown ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : [0x40 | (body.length >> 8), body.length & 0xff]
  return [...idBytes, ...size, ...body]
}
const opusHead = [...new TextEncoder().encode('OpusHead'), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]
const packet = (n) => [0xf8, ...Array.from({ length: n }, (_, i) => i & 0xff)] // config 31: 20 ms CELT, one frame
const block = (p, t) => el(0xa3, [0x81, 0, t, 0x80, ...p])
const webm = Uint8Array.from([
  ...el(0x1a45dfa3, [0x42, 0x86, 0x81, 0x01]),
  ...el(0x18538067, [], true),
  ...el(0x1654ae6b, el(0xae, [...el(0x86, [...new TextEncoder().encode('A_OPUS')]), ...el(0x63a2, opusHead)])),
  ...el(0x1f43b675, [], true),
  ...el(0xe7, [0]),
  ...block(packet(40), 0),
  ...block(packet(300), 20),
  ...block(packet(10), 40)
])

test('reads the Opus header and packets out of a WebM recording', () => {
  const { head, packets } = readWebmOpus(webm)
  assert.equal(String.fromCharCode(...head.slice(0, 8)), 'OpusHead')
  assert.deepEqual(
    packets.map((p) => p.length),
    [41, 301, 11]
  )
  assert.throws(() => readWebmOpus(new Uint8Array([1, 2, 3])))
})

test('opusSamples reads packet length from the first byte', () => {
  assert.equal(opusSamples([0xf8]), 960) // 20 ms
  assert.equal(opusSamples([0xf9]), 1920) // two 20 ms frames
  assert.equal(opusSamples([0x08 | 0x00]), 960) // SILK 20 ms
  assert.equal(opusSamples([0xfb, 0x03]), 2880) // three frames
})

// Ogg's CRC, computed independently from the page bytes, to check every page's checksum.
function crc(bytes) {
  let c = 0
  for (const b of bytes) {
    c ^= b << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    c >>>= 0
  }
  return c
}

test('writes a valid OGG Opus file with the same audio packets', () => {
  const { ogg, seconds } = webmToOgg(webm)
  assert.equal(seconds, 0.06)
  const pages = []
  for (let at = 0; at < ogg.length; ) {
    assert.equal(String.fromCharCode(...ogg.slice(at, at + 4)), 'OggS')
    const segs = ogg[at + 26]
    const lacing = ogg.slice(at + 27, at + 27 + segs)
    const len = 27 + segs + lacing.reduce((s, v) => s + v, 0)
    const page = ogg.slice(at, at + len)
    const view = new DataView(page.buffer)
    const stored = view.getUint32(22, true)
    view.setUint32(22, 0, true)
    assert.equal(crc(page), stored, 'page checksum')
    pages.push({ flags: page[5], granule: Number(view.getBigUint64(6, true)), seq: view.getUint32(18, true), data: page.slice(27 + segs) })
    at += len
  }
  assert.equal(pages.length, 3)
  assert.equal(pages[0].flags, 0x02)
  assert.equal(String.fromCharCode(...pages[0].data.slice(0, 8)), 'OpusHead')
  assert.equal(String.fromCharCode(...pages[1].data.slice(0, 8)), 'OpusTags')
  assert.equal(pages[2].flags, 0x04)
  assert.equal(pages[2].granule, 3 * 960 + 312) // samples plus the 312-sample pre-skip in the header
  assert.deepEqual(pages.map((p) => p.seq), [0, 1, 2])
  assert.equal(pages[2].data.length, 41 + 301 + 11)
})

test('voice waveforms survive packing and unpacking', () => {
  const values = Array.from({ length: 100 }, (_, i) => (i * 7) % 32)
  assert.deepEqual(decodeWaveform(encodeWaveform(values)).slice(0, 100), values)
  assert.deepEqual(decodeWaveform(encodeWaveform([40, -3])).slice(0, 2), [31, 0])
})
