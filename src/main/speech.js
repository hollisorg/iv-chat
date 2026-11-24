// Voice to text on this computer: Telegram voice messages for the person's AI (MCP transcribe_voice) and
// the "Show text" button, and the person's own spoken instructions for the Draft button.
//
// The engine is whisper.cpp, the same one IV Voice uses. If IV Voice is installed, its engine and model are
// used as they are (read only, nothing in IV Voice's folder changes); otherwise Settings > Voice to text
// downloads one into IV Chat's own folder, checked against published SHA-256 digests. Audio is decoded in a
// hidden, offline window (Chromium's own decoders read Ogg Opus and MP4), turned into a WAV and sent to
// whisper-server on 127.0.0.1. Nothing is uploaded, and transcripts are kept in memory only.
import { BrowserWindow, app, net, session } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import netSock from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { MODELS, cleanSpeech, findEngine, wavFromPcm16 } from './speech-text.js'

const MAX_SECONDS = 15 * 60
const MAX_TRANSCRIPTS = 1000
const IDLE_STOP_MS = 3 * 60e3 // the engine lets go of the GPU after 3 quiet minutes
const DECODER_IDLE_MS = 60e3

// ---------- whisper-server ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netSock.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

class WhisperServer {
  constructor() {
    this.proc = null
    this.port = null
    this.config = null
    this.starting = null
    this.idleTimer = null
    this.log = []
  }

  get running() {
    return Boolean(this.proc && this.proc.exitCode === null && this.port)
  }

  configure(config) {
    const key = JSON.stringify(config)
    if (key !== this.configKey && this.running) this.stop()
    this.config = config
    this.configKey = key
  }

  async ensure() {
    if (this.running) return
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = null))
    return this.starting
  }

  async start() {
    const { serverPath, modelPath, useGpu } = this.config || {}
    this.port = await freePort()
    const threads = Math.max(2, Math.min(8, os.cpus().length - 2))
    // Messages arrive in any language, so whisper works out which one.
    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(this.port), '-t', String(threads), '-l', 'auto']
    if (!useGpu) args.push('-ng')
    this.log = []
    this.proc = spawn(serverPath, args, { cwd: path.dirname(serverPath), windowsHide: true })
    const keep = (d) => {
      this.log.push(String(d))
      if (this.log.length > 200) this.log.splice(0, 100)
    }
    this.proc.stdout.on('data', keep)
    this.proc.stderr.on('data', keep)
    this.proc.on('exit', () => {
      this.proc = null
      this.port = null
    })
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(`The speech engine stopped while starting: ${this.tail()}`)
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) return
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    this.stop()
    throw new Error('The speech engine took too long to start')
  }

  tail() {
    return this.log.join('').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
  }

  async transcribe(wav) {
    clearTimeout(this.idleTimer)
    await this.ensure()
    try {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
      form.append('response_format', 'json')
      form.append('temperature', '0')
      const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(280_000) })
      if (!res.ok) throw new Error(`Speech engine error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const body = await res.json()
      if (body.error) throw new Error(`Speech engine error: ${body.error}`)
      return String(body.text || '')
    } finally {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS)
    }
  }

  stop() {
    clearTimeout(this.idleTimer)
    if (this.proc && this.proc.exitCode === null) this.proc.kill()
    this.proc = null
    this.port = null
  }
}

// ---------- decoding audio to 16 kHz mono ----------

// Runs in the hidden window. decodeAudioData resamples to the context's 16 kHz; channels are averaged.
const DECODE = `(async (b64) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.buffer)
  const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c))
  const out = new Int16Array(audio.length)
  for (let i = 0; i < audio.length; i++) {
    let s = 0
    for (const d of chans) s += d[i]
    s /= chans.length
    out[i] = Math.round(Math.max(-1, Math.min(1, s)) * 32767)
  }
  const u8 = new Uint8Array(out.buffer)
  let str = ''
  for (let i = 0; i < u8.length; i += 0x8000) str += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return { pcm: btoa(str), seconds: audio.duration }
})`

class Decoder {
  constructor() {
    this.win = null
    this.ready = null
    this.timer = null
  }

  open() {
    if (this.win && !this.win.isDestroyed()) return this.ready
    const ses = session.fromPartition('iv-chat-decode')
    // An empty page with no network, no permissions and no Node: it only runs the decoder above.
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }))
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    this.win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      skipTaskbar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, javascript: true }
    })
    this.ready = this.win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>IV Chat audio</title>')
    return this.ready
  }

  async decode(bytes) {
    clearTimeout(this.timer)
    try {
      await this.open()
      const { pcm, seconds } = await this.win.webContents.executeJavaScript(`${DECODE}(${JSON.stringify(Buffer.from(bytes).toString('base64'))})`)
      return { pcm: Buffer.from(pcm, 'base64'), seconds }
    } catch (err) {
      throw new Error(/decode|Unable/i.test(String(err?.message || err)) ? "That recording's audio could not be read" : String(err?.message || err))
    } finally {
      this.timer = setTimeout(() => this.close(), DECODER_IDLE_MS)
    }
  }

  close() {
    clearTimeout(this.timer)
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

// ---------- setting up IV Chat's own engine ----------

const RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15'
const MODEL_TREE = 'https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main'
const MODEL_URL = (file) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`
const VARIANTS = {
  cuda: { label: 'NVIDIA GPU', asset: /^whisper-(bin-win-cuda-12[\d.]*-x64|cublas-12[\d.]*-bin-x64)\.zip$/ },
  cpu: { label: 'CPU', asset: /^whisper-bin-x64\.zip$/ }
}

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

// A streamed download, hashed as it arrives and kept only if the SHA-256 matches.
async function downloadVerified({ url, dest, sha256, size, onProgress }) {
  if (!/^[a-f0-9]{64}$/i.test(sha256 || '')) throw new Error(`No checksum is published for ${path.basename(dest)}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.download`
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} downloading ${path.basename(dest)}`)
  const total = Number(res.headers.get('content-length')) || size || 0
  const hash = createHash('sha256')
  const out = fs.createWriteStream(tmp)
  let received = 0
  let last = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) await new Promise((r) => out.once('drain', r))
      if (Date.now() - last > 200) {
        last = Date.now()
        onProgress(total ? Math.round((received / total) * 100) : null)
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    fs.rmSync(tmp, { force: true })
    throw err
  }
  if (hash.digest('hex').toLowerCase() !== sha256.toLowerCase()) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`${path.basename(dest)} failed its checksum, so nothing was installed`)
  }
  fs.renameSync(tmp, dest)
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry.name.toLowerCase() === name.toLowerCase()) return p
  }
  return null
}

function hasNvidiaGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(!err && Boolean(String(out).trim())))
  })
}

// ---------- the service ----------

export class Speech extends EventEmitter {
  constructor({ telegram, userData = app.getPath('userData'), appData = app.getPath('appData') }) {
    super()
    this.telegram = telegram
    this.chatDir = path.join(userData, 'speech')
    this.voiceDir = path.join(appData, 'IV Voice')
    this.server = new WhisperServer()
    this.decoder = new Decoder()
    this.queue = Promise.resolve()
    this.inFlight = new Map()
    this.setup = null // { phase, percent } while Settings is setting up the engine
  }

  engine() {
    return findEngine({ chatDir: this.chatDir, voiceDir: this.voiceDir })
  }

  status() {
    const e = this.engine()
    return {
      ready: Boolean(e),
      source: e?.source || null,
      model: e ? MODELS[e.model].label : null,
      gpu: Boolean(e?.useGpu),
      setup: this.setup
    }
  }

  // Downloads whisper.cpp and a model into IV Chat's folder: the GPU build and Turbo with an NVIDIA card,
  // else the CPU build and Small. Only from the person's click in Settings.
  async install() {
    if (this.setup) throw new Error('Voice to text is already being set up')
    const report = (phase, percent = null) => {
      this.setup = { phase, percent }
      this.emit('status', this.status())
    }
    try {
      report('Checking this computer')
      const gpu = await hasNvidiaGpu()
      const variant = gpu ? 'cuda' : 'cpu'
      const modelKey = gpu ? 'turbo' : 'small'
      const engineDir = path.join(this.chatDir, 'engine')
      report('Finding the speech engine')
      const releases = await fetchJson(RELEASES)
      let found = null
      for (const rel of releases) {
        if (rel.draft || rel.prerelease) continue
        const asset = rel.assets.find((a) => VARIANTS[variant].asset.test(a.name))
        if (asset) {
          found = { tag: rel.tag_name, asset }
          break
        }
      }
      if (!found) throw new Error(`No ${VARIANTS[variant].label} build was found in recent whisper.cpp releases`)
      const zip = path.join(engineDir, 'downloads', found.asset.name)
      await downloadVerified({
        url: found.asset.browser_download_url,
        dest: zip,
        sha256: String(found.asset.digest || '').replace(/^sha256:/, ''),
        size: found.asset.size,
        onProgress: (p) => report('Downloading the speech engine', p)
      })
      report('Unpacking the speech engine')
      const dest = path.join(engineDir, `${variant}-${found.tag}`)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(dest, { recursive: true })
      await new Promise((resolve, reject) => {
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        const p = spawn(tar, ['-xf', zip, '-C', dest], { windowsHide: true })
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed: ${err.trim()}`))))
      })
      fs.rmSync(zip, { force: true })
      const serverPath = findFile(dest, 'whisper-server.exe')
      if (!serverPath) throw new Error('whisper-server.exe was not in the download')
      const model = MODELS[modelKey]
      report(`Downloading the ${model.label} model (${model.mb} MB)`)
      const tree = await fetchJson(MODEL_TREE)
      const entry = tree.find((f) => f.path === model.file)
      await downloadVerified({
        url: MODEL_URL(model.file),
        dest: path.join(this.chatDir, 'models', model.file),
        sha256: entry?.lfs?.oid,
        size: entry?.size,
        onProgress: (p) => report(`Downloading the ${model.label} model (${model.mb} MB)`, p)
      })
      fs.writeFileSync(path.join(engineDir, 'engine.json'), JSON.stringify({ variant, tag: found.tag, dir: dest, serverPath }, null, 2))
    } finally {
      this.setup = null
      this.emit('status', this.status())
    }
    return this.status()
  }

  // Any audio Chromium can decode (Ogg Opus voice notes, MP4 round videos, WebM from the microphone) to text.
  transcribeBytes(bytes) {
    const run = async () => {
      const engine = this.engine()
      if (!engine) throw new Error('Voice to text is not set up on this computer yet. Set it up in IV Chat > Settings > Voice to text (or install IV Voice).')
      const { pcm, seconds } = await this.decoder.decode(bytes)
      if (seconds > MAX_SECONDS) throw new Error('That recording is longer than 15 minutes, too long to transcribe here')
      if (seconds < 0.3) return { text: '', seconds, engine }
      this.server.configure({ serverPath: engine.serverPath, modelPath: engine.modelPath, useGpu: engine.useGpu })
      return { text: cleanSpeech(await this.server.transcribe(wavFromPcm16(pcm))), seconds, engine }
    }
    // One recording at a time, so the engine isn't asked for two things at once.
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  cached(id, msgId) {
    return this.telegram?.transcripts.get(`${String(id)}:${Number(msgId)}`)
  }

  // A Telegram voice message, round video or audio file, transcribed once and remembered while IV Chat runs.
  async telegramMessage(id, msgId) {
    const key = `${String(id)}:${Number(msgId)}`
    const known = this.telegram.transcripts.get(key)
    if (known !== undefined) return { text: known, cached: true }
    if (this.inFlight.has(key)) return this.inFlight.get(key)
    const work = (async () => {
      const src = await this.telegram.speechSource(id, msgId)
      const { text } = await this.transcribeBytes(src.bytes)
      const store = this.telegram.transcripts
      store.set(key, text)
      if (store.size > MAX_TRANSCRIPTS) store.delete(store.keys().next().value)
      this.emit('transcript', { chatId: String(id), msgId: Number(msgId), text })
      return { kind: src.kind, seconds: src.seconds, from: src.from, at: src.at, text }
    })()
    this.inFlight.set(key, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(key)
    }
  }

  stop() {
    this.server.stop()
    this.decoder.close()
  }
}
