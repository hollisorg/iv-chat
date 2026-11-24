// Pure helpers for voice to text (speech.js): finding a speech engine on this computer, building the WAV
// that whisper.cpp reads, and tidying what it hears. No Electron here, so the tests can use them.
import fs from 'node:fs'
import path from 'node:path'

// The models IV Voice and IV Chat download (ggml builds of Whisper), best first.
export const MODELS = {
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Turbo', mb: 574 },
  small: { file: 'ggml-small-q5_1.bin', label: 'Small', mb: 190 },
  base: { file: 'ggml-base-q5_1.bin', label: 'Base', mb: 60 }
}
const ORDER = ['turbo', 'small', 'base']

function readManifest(file, exists, read) {
  try {
    const m = JSON.parse(read(file))
    if (m?.serverPath && exists(m.serverPath)) return m
  } catch {
    /* not installed */
  }
  return null
}

// One place's engine (IV Chat's own folder, or IV Voice's), or null. The best installed model wins.
export function engineAt(dir, source, { exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const m = readManifest(path.join(dir, 'engine', 'engine.json'), exists, read)
  if (!m) return null
  const key = ORDER.find((k) => exists(path.join(dir, 'models', MODELS[k].file)))
  if (!key) return null
  return { source, serverPath: m.serverPath, modelPath: path.join(dir, 'models', MODELS[key].file), model: key, useGpu: m.variant === 'cuda', variant: m.variant }
}

// IV Chat's own engine first (set up from Settings), else the one IV Voice already installed. IV Voice's
// files are only read, never changed.
export function findEngine({ chatDir, voiceDir, ...io }) {
  return engineAt(chatDir, 'IV Chat', io) || (voiceDir ? engineAt(voiceDir, 'IV Voice', io) : null)
}

// 16-bit mono PCM to a WAV file.
export function wavFromPcm16(pcm, rate = 16000) {
  const data = Buffer.from(pcm.buffer ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

// Whisper sometimes "hears" these in near-silence; drop them when they are all there is.
const SILENCE = /^(thank you\.?|thanks for watching[.!]?|you\.?|bye\.?|\.)$/i

// What was said, without whisper's markers ([BLANK_AUDIO], (music)) and with tidy spacing. Filler words are
// kept: this is someone's message, so it stays as they said it.
export function cleanSpeech(raw) {
  const text = String(raw || '')
    .replace(/\[[^\]]*\]|\([^)]*(music|silence|inaudible|blank|applause|laughs?)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return !text || SILENCE.test(text) ? '' : text
}
