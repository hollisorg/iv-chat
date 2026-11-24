// Pictures, voice messages and picture drafts through the MCP (view_photo, transcribe_voice, draft_reply
// with photo_path), plus the helpers behind them. Everything here is made up; no real chats or files.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RateLimiter, cleanAi } from '../src/main/ai-access.js'
import { createTools } from '../src/main/mcp-tools.js'
import { checkPicture, copyPicture, pictureType } from '../src/main/ai-photo.js'
import { cleanSpeech, engineAt, findEngine, wavFromPcm16 } from '../src/main/speech-text.js'

const NOW = new Date(2026, 10, 24, 14, 0).getTime()
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])

function setup({ speechText = 'see you at six', mediaMax = 120 } = {}) {
  const transcripts = new Map()
  const telegram = {
    status: 'ready',
    drafts: [],
    transcripts,
    dialogList: () => [
      { id: '111', name: 'Sam', unread: 1, preview: 'Voice message', at: NOW - 60e3 },
      { id: '222', name: 'Hidden', unread: 0, preview: 'ok', at: NOW - 60e3 }
    ],
    updates: [],
    async messages() {
      return [
        { id: 5, from: 'Sam', text: '', at: NOW - 3000, media: { kind: 'voice', duration: 4, bars: [0.1, 0.5], size: 9000 } },
        { id: 6, from: 'Sam', text: 'look', at: NOW - 2000, media: { kind: 'photo', w: 800, h: 600 }, entities: [], body: 'look', caption: 'look' },
        { id: 7, from: 'Sam', text: 'hi', at: NOW - 1000, media: null, transcript: undefined }
      ].map((m) => (transcripts.has(`111:${m.id}`) ? { ...m, transcript: transcripts.get(`111:${m.id}`) } : m))
    },
    async pictureForAi(id, msgId) {
      if (msgId !== 6) throw new Error('That message has no picture to look at')
      return { data: JPEG.toString('base64'), mime: 'image/jpeg', kind: 'photo', caption: 'look', from: 'Sam', at: NOW - 2000 }
    },
    async saveDraft(id, text) {
      this.drafts.push({ id, text })
    }
  }
  const speech = {
    calls: 0,
    cached: (id, msgId) => transcripts.get(`${id}:${msgId}`),
    async telegramMessage(id, msgId) {
      const known = transcripts.get(`${id}:${msgId}`)
      if (known !== undefined) return { text: known, cached: true }
      if (msgId !== 5) throw new Error('That message is not a voice message, round video or audio file')
      this.calls++
      transcripts.set(`${id}:${msgId}`, speechText)
      return { kind: 'voice', seconds: 4, from: 'Sam', at: NOW - 3000, text: speechText }
    }
  }
  const staged = []
  const placed = []
  const call = createTools({
    telegram,
    getWebChats: () => ({ whatsapp: { status: 'ok', chats: [{ id: '', name: 'Jo', preview: 'hey', time: '1:30 PM', unread: 0 }] } }),
    getAi: () => cleanAi({ mode: 'chosen', allowed: ['telegram:111', 'whatsapp:Jo'] }),
    limiter: new RateLimiter({ calls: { max: 60, windowMs: 60e3 }, drafts: { max: 20, windowMs: 3600e3 }, media: { max: mediaMax, windowMs: 3600e3 } }, () => NOW),
    log: () => {},
    onDraft: (key, text, file) => placed.push({ key, text, file }),
    speech,
    stagePhoto: async (p) => {
      const info = checkPicture(p)
      staged.push(p)
      return { token: 't1', name: info.name, size: info.size, image: true, fromAi: true }
    },
    now: () => NOW
  })
  return { call, telegram, speech, staged, placed }
}

test('read_chat leaves out drawing details and says which tool opens voice messages and pictures', async () => {
  const { call } = setup()
  const { messages } = await call('read_chat', { chat_id: 'telegram:111' })
  const [voice, photo, plain] = messages
  assert.equal(voice.media.bars, undefined)
  assert.match(voice.transcript_hint, /transcribe_voice/)
  assert.match(photo.picture_hint, /view_photo/)
  assert.equal(photo.entities, undefined)
  assert.equal(plain.picture_hint, undefined)
  assert.equal(plain.transcript_hint, undefined)
  assert.equal(voice.time, new Date(NOW - 3000).toISOString())
})

test('view_photo returns the picture as an image, only in chats the AI may see', async () => {
  const { call } = setup()
  const res = await call('view_photo', { chat_id: 'telegram:111', message_id: 6 })
  assert.equal(res.image.mimeType, 'image/jpeg')
  assert.equal(Buffer.from(res.image.data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff')
  assert.equal(res.caption, 'look')
  assert.match((await call('view_photo', { chat_id: 'telegram:222', message_id: 6 })).error, /allowed to see/)
  assert.match((await call('view_photo', { chat_id: 'telegram:111', message_id: 7 })).error, /no picture/)
  assert.match((await call('view_photo', { chat_id: 'telegram:111', message_id: 'x' })).error, /message id/)
  assert.match((await call('view_photo', { chat_id: 'whatsapp:Jo', message_id: 1 })).error, /Telegram chats for now/)
})

test('transcribe_voice gives the text once, then read_chat carries it', async () => {
  const { call, speech } = setup()
  const res = await call('transcribe_voice', { chat_id: 'telegram:111', message_id: 5 })
  assert.equal(res.transcript, 'see you at six')
  assert.equal(res.seconds, 4)
  const again = await call('transcribe_voice', { chat_id: 'telegram:111', message_id: 5 })
  assert.equal(again.transcript, 'see you at six')
  assert.equal(speech.calls, 1)
  const { messages } = await call('read_chat', { chat_id: 'telegram:111' })
  assert.equal(messages[0].transcript, 'see you at six')
  assert.equal(messages[0].transcript_hint, undefined)
  assert.match((await call('transcribe_voice', { chat_id: 'telegram:111', message_id: 6 })).error, /not a voice message/)
})

test('transcribe_voice says so when nothing was said', async () => {
  const { call } = setup({ speechText: '' })
  const res = await call('transcribe_voice', { chat_id: 'telegram:111', message_id: 5 })
  assert.equal(res.transcript, '')
  assert.match(res.note, /No speech/)
})

test('pictures and voice messages share an hourly limit; cached transcripts do not count', async () => {
  const { call } = setup({ mediaMax: 1 })
  await call('transcribe_voice', { chat_id: 'telegram:111', message_id: 5 })
  assert.equal((await call('transcribe_voice', { chat_id: 'telegram:111', message_id: 5 })).transcript, 'see you at six')
  assert.match((await call('view_photo', { chat_id: 'telegram:111', message_id: 6 })).error, /limit reached/)
})

test('draft_reply with a picture stages it for the person and never sends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivchat-photo-'))
  try {
    const pic = path.join(dir, 'idea.png')
    fs.writeFileSync(pic, PNG)
    const { call, telegram, placed, staged } = setup()
    const res = await call('draft_reply', { chat_id: 'telegram:111', text: 'here is the layout', photo_path: pic })
    assert.equal(res.status, 'draft placed')
    assert.equal(res.picture, 'idea.png')
    assert.match(res.note, /Nothing was sent/)
    assert.deepEqual(staged, [pic])
    assert.equal(placed[0].file.token, 't1')
    assert.equal(placed[0].text, 'here is the layout')
    assert.deepEqual(telegram.drafts, [{ id: '111', text: 'here is the layout' }])

    // A picture alone is fine; it isn't saved as a Telegram text draft.
    await call('draft_reply', { chat_id: 'telegram:111', photo_path: pic })
    assert.equal(telegram.drafts.length, 1)

    assert.match((await call('draft_reply', { chat_id: 'telegram:111', text: 'x'.repeat(1025), photo_path: pic })).error, /1024/)
    assert.match((await call('draft_reply', { chat_id: 'whatsapp:Jo', text: 'hi', photo_path: pic })).error, /Telegram chats for now/)
    const notPic = path.join(dir, 'notes.png')
    fs.writeFileSync(notPic, 'just text pretending to be a picture')
    assert.match((await call('draft_reply', { chat_id: 'telegram:111', photo_path: notPic })).error, /JPEG, PNG, WebP and GIF/)
    assert.match((await call('draft_reply', { chat_id: 'telegram:111', photo_path: 'relative.png' })).error, /full path/)
    assert.match((await call('draft_reply', { chat_id: 'telegram:111' })).error, /empty/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pictureType reads the first bytes, not the name', () => {
  assert.equal(pictureType(JPEG), 'image/jpeg')
  assert.equal(pictureType(PNG), 'image/png')
  assert.equal(pictureType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp')
  assert.equal(pictureType(Buffer.from('GIF89a', 'latin1')), 'image/gif')
  assert.equal(pictureType(Buffer.from('%PDF-1.7', 'latin1')), null)
  assert.equal(pictureType(Buffer.alloc(0)), null)
})

test('copyPicture copies under a fresh, safe name and refuses big or odd files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivchat-copy-'))
  try {
    const src = path.join(dir, 'My picture (1).jpg')
    fs.writeFileSync(src, JPEG)
    const out = copyPicture(src, path.join(dir, 'uploads'), 'abc')
    assert.equal(out.mime, 'image/jpeg')
    assert.equal(path.basename(out.path), 'ai-abc-My_picture__1_.jpg')
    assert.deepEqual(fs.readFileSync(out.path), JPEG)
    // A PNG named .jpg keeps its real type.
    const lying = path.join(dir, 'fake.jpg')
    fs.writeFileSync(lying, PNG)
    assert.equal(copyPicture(lying, path.join(dir, 'uploads'), 'def').name, 'fake.png')
    const big = path.join(dir, 'big.jpg')
    fs.writeFileSync(big, Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]))
    assert.throws(() => checkPicture(big), /10 MB/)
    assert.throws(() => checkPicture(dir), /not a file/)
    assert.throws(() => checkPicture(path.join(dir, 'missing.png')), /no file/)
    assert.throws(() => checkPicture('\\\\server\\share\\a.png'), /network shares/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('findEngine prefers IV Chat\'s own engine, falls back to IV Voice\'s, and picks the best model', () => {
  const files = new Map()
  const io = { exists: (f) => files.has(path.normalize(f)), read: (f) => files.get(path.normalize(f)) }
  const put = (f, body = '') => files.set(path.normalize(f), body)
  const chat = path.join('C:', 'data', 'IV Chat', 'speech')
  const voice = path.join('C:', 'data', 'IV Voice')
  assert.equal(findEngine({ chatDir: chat, voiceDir: voice, ...io }), null)

  put(path.join(voice, 'engine', 'engine.json'), JSON.stringify({ variant: 'cuda', serverPath: 'C:\\v\\whisper-server.exe' }))
  put('C:\\v\\whisper-server.exe')
  assert.equal(findEngine({ chatDir: chat, voiceDir: voice, ...io }), null) // no model yet
  put(path.join(voice, 'models', 'ggml-small-q5_1.bin'))
  put(path.join(voice, 'models', 'ggml-large-v3-turbo-q5_0.bin'))
  const fromVoice = findEngine({ chatDir: chat, voiceDir: voice, ...io })
  assert.equal(fromVoice.source, 'IV Voice')
  assert.equal(fromVoice.model, 'turbo')
  assert.equal(fromVoice.useGpu, true)

  put(path.join(chat, 'engine', 'engine.json'), JSON.stringify({ variant: 'cpu', serverPath: 'C:\\c\\whisper-server.exe' }))
  put('C:\\c\\whisper-server.exe')
  put(path.join(chat, 'models', 'ggml-base-q5_1.bin'))
  const own = findEngine({ chatDir: chat, voiceDir: voice, ...io })
  assert.equal(own.source, 'IV Chat')
  assert.equal(own.model, 'base')
  assert.equal(own.useGpu, false)

  // A manifest pointing at a missing exe doesn't count.
  put(path.join(chat, 'engine', 'engine.json'), JSON.stringify({ variant: 'cpu', serverPath: 'C:\\gone.exe' }))
  assert.equal(engineAt(chat, 'IV Chat', io), null)
})

test('wavFromPcm16 writes a 16 kHz mono WAV header', () => {
  const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 32767]).buffer)
  const wav = wavFromPcm16(pcm)
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF')
  assert.equal(wav.toString('latin1', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt32LE(40), 8)
  assert.equal(wav.length, 52)
  assert.equal(wav.readInt16LE(46), 1000)
})

test('cleanSpeech drops whisper markers and silence phrases but keeps what was said', () => {
  assert.equal(cleanSpeech(' [BLANK_AUDIO] '), '')
  assert.equal(cleanSpeech('Thank you.'), '')
  assert.equal(cleanSpeech('(music) um so are we still on for six?  '), 'um so are we still on for six?')
  assert.equal(cleanSpeech('Hola, ¿qué tal?'), 'Hola, ¿qué tal?')
})
