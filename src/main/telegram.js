// Telegram, connected directly to the person's own account through Telegram's official user API (GramJS).
// Sign-in is by QR code from the Telegram app on their phone, plus their two-step password if they have one.
// The session is stored encrypted (secure-store). Sending happens only from the person's own keypress in the
// IV Chat window (see index.js); the AI side only ever reads and saves drafts.
import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import { Api, TelegramClient, utils } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, Raw } from 'telegram/events/index.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { deleteSecret, readSecret, writeSecret } from './secure-store'
import { decodeWaveform, waveformBars } from './waveform.js'

const KEYS = 'telegram-app'
const SESSION = 'telegram-session'
const MAX_UPDATES = 200
const MAX_PREVIEWS = 300
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

const peerId = (id) => String(id)

function dialogName(d) {
  return d.title || d.name || [d.entity?.firstName, d.entity?.lastName].filter(Boolean).join(' ') || 'Unknown'
}

function senderName(msg, me) {
  if (msg.out) return 'You'
  const s = msg.sender
  if (!s) return ''
  if (s.id && me && String(s.id) === String(me.id)) return 'You'
  return s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || ''
}

// What a message carries besides text, for showing it: a photo, video, voice note, sticker or file.
function mediaInfo(msg) {
  const media = msg.media
  if (!media) return null
  if (media.className === 'MessageMediaPhoto') return { kind: 'photo' }
  if (media.className === 'MessageMediaDocument' && media.document) {
    const d = media.document
    const attrs = d.attributes || []
    const has = (name) => attrs.find((a) => a.className === name)
    const audio = has('DocumentAttributeAudio')
    const kind = has('DocumentAttributeSticker') ? 'sticker' : audio?.voice ? 'voice' : audio ? 'audio' : has('DocumentAttributeVideo') ? 'video' : 'file'
    return {
      kind,
      name: has('DocumentAttributeFilename')?.fileName || '',
      size: Number(String(d.size ?? 0)),
      mime: d.mimeType || '',
      duration: Number(audio?.duration || has('DocumentAttributeVideo')?.duration || 0),
      // Voice messages carry their own loudness shape; the player draws it as bars.
      bars: audio ? waveformBars(decodeWaveform(audio.waveform), 44, Number(String(d.id ?? 1).slice(-9))) : undefined,
      preview: Boolean(d.thumbs?.length) || (kind === 'sticker' && d.mimeType === 'image/webp')
    }
  }
  return { kind: 'other', label: media.className?.replace(/^MessageMedia/, '') || 'Media' }
}

// The reactions under a message: each emoji, how many people chose it, and whether one of them is you.
// Custom (premium) emoji reactions can't be drawn here, so they show as a star.
function reactionList(msg) {
  return (msg.reactions?.results || []).map((r) => ({
    emoji: r.reaction?.className === 'ReactionEmoji' ? r.reaction.emoticon : '★',
    custom: r.reaction?.className !== 'ReactionEmoji',
    count: r.count || 0,
    mine: r.chosenOrder !== undefined && r.chosenOrder !== null
  }))
}

function messageText(msg) {
  if (msg.message) return msg.message
  if (msg.media) {
    const kind = msg.media.className?.replace(/^MessageMedia/, '') || 'media'
    return `[${kind === 'Photo' ? 'Photo' : kind === 'Document' ? 'File' : kind}]`
  }
  return ''
}

export class TelegramService extends EventEmitter {
  constructor() {
    super()
    this.client = null
    this.me = null
    this.status = 'starting' // needs-keys | signed-out | qr | password | connecting | ready | error
    this.qr = null
    this.passwordHint = ''
    this.error = null
    this.dialogs = new Map() // peer id -> { id, name, kind, unread, preview, at, entity }
    this.updates = [] // incoming messages since start, newest last
    this.passwordWaiter = null
    this.previews = new Map() // "chat:message" -> data URL of a photo or thumbnail, kept in memory
  }

  // Only the fields the UI needs; never the session or keys.
  state() {
    return {
      status: this.status,
      qr: this.qr,
      passwordHint: this.passwordHint,
      error: this.error,
      me: this.me ? { name: [this.me.firstName, this.me.lastName].filter(Boolean).join(' ') } : null
    }
  }

  set(patch) {
    Object.assign(this, patch)
    this.emit('state', this.state())
  }

  appKeys() {
    const env = process.env.IV_CHAT_TG_API_ID && process.env.IV_CHAT_TG_API_HASH
    if (env) return { apiId: Number(process.env.IV_CHAT_TG_API_ID), apiHash: process.env.IV_CHAT_TG_API_HASH }
    return readSecret(KEYS)
  }

  saveAppKeys(apiId, apiHash) {
    const id = Number(apiId)
    if (!Number.isInteger(id) || id <= 0) throw new Error('The api_id is a number from my.telegram.org')
    if (!/^[0-9a-f]{32}$/i.test(String(apiHash || '').trim())) throw new Error('The api_hash is the 32-character code from my.telegram.org')
    writeSecret(KEYS, { apiId: id, apiHash: String(apiHash).trim().toLowerCase() })
    return this.start()
  }

  async start() {
    const keys = this.appKeys()
    if (!keys) return this.set({ status: 'needs-keys', error: null })
    const session = readSecret(SESSION)?.session || ''
    await this.disconnect()
    this.client = new TelegramClient(new StringSession(session), keys.apiId, keys.apiHash, {
      connectionRetries: 5,
      deviceModel: 'IV Chat',
      appVersion: '0.1',
      systemVersion: 'Windows'
    })
    this.client.setLogLevel(LogLevel.ERROR)
    this.client.setParseMode(undefined)
    this.set({ status: 'connecting', error: null })
    try {
      await this.client.connect()
      if (await this.client.checkAuthorization()) return this.ready()
      this.set({ status: 'signed-out' })
    } catch (err) {
      this.set({ status: 'error', error: String(err?.message || err) })
    }
  }

  // QR sign-in: the token is shown as a QR code that the person scans in Telegram on their phone
  // (Settings > Devices > Link Desktop Device). Telegram refreshes it until it's scanned.
  async signIn() {
    const keys = this.appKeys()
    if (!this.client || !keys) return
    this.set({ status: 'qr', qr: null, error: null })
    try {
      await this.client.signInUserWithQrCode(keys, {
        qrCode: async ({ token }) => {
          const link = `tg://login?token=${token.toString('base64url')}`
          const qr = await QRCode.toDataURL(link, { margin: 1, width: 280, color: { dark: '#100c0e', light: '#f1ede5' } })
          this.set({ status: 'qr', qr })
        },
        password: (hint) =>
          new Promise((resolve, reject) => {
            this.passwordWaiter = { resolve, reject }
            this.set({ status: 'password', qr: null, passwordHint: hint || '' })
          }),
        onError: async (err) => {
          // A wrong password lets the person try again; anything else ends this attempt.
          if (/PASSWORD_HASH_INVALID/.test(err?.message || '')) {
            this.set({ error: 'That password is not right. Try again.' })
            return false
          }
          this.set({ status: 'signed-out', qr: null, error: String(err?.message || err) })
          return true
        }
      })
      await this.ready()
    } catch (err) {
      if (this.status !== 'signed-out') this.set({ status: 'signed-out', qr: null, error: String(err?.message || err) })
    }
  }

  submitPassword(password) {
    if (!this.passwordWaiter) return
    const w = this.passwordWaiter
    this.passwordWaiter = null
    this.set({ status: 'connecting', error: null })
    w.resolve(String(password ?? ''))
  }

  cancelSignIn() {
    this.passwordWaiter?.reject(new Error('Cancelled'))
    this.passwordWaiter = null
    return this.start()
  }

  async ready() {
    writeSecret(SESSION, { session: this.client.session.save() })
    this.me = await this.client.getMe()
    this.client.addEventHandler((e) => this.onMessage(e), new NewMessage({}))
    // Someone reacted: tell the open conversation to refresh.
    this.client.addEventHandler(
      (update) => {
        try {
          this.emit('message', String(utils.getPeerId(update.peer)))
        } catch {
          /* not a chat we show */
        }
      },
      new Raw({ types: [Api.UpdateMessageReactions] })
    )
    await this.refreshDialogs()
    this.set({ status: 'ready', qr: null, passwordHint: '', error: null })
  }

  async signOut() {
    try {
      if (this.client && this.status === 'ready') await this.client.invoke(new Api.auth.LogOut())
    } catch {
      /* the local session is removed either way */
    }
    deleteSecret(SESSION)
    this.me = null
    this.dialogs.clear()
    this.updates = []
    this.emit('dialogs', [])
    await this.start()
  }

  async disconnect() {
    if (!this.client) return
    try {
      await this.client.disconnect()
    } catch {
      /* already closed */
    }
    this.client = null
  }

  // ---------- reading ----------

  async refreshDialogs() {
    const list = await this.client.getDialogs({ limit: 60 })
    // Built off to the side and swapped in at the end, so chats never vanish mid-refresh.
    const next = new Map()
    for (const d of list) {
      if (d.archived) continue
      next.set(peerId(d.id), {
        id: peerId(d.id),
        // Your own chat is "Saved Messages", as in Telegram's apps.
        name: d.entity?.self ? 'Saved Messages' : dialogName(d),
        kind: d.entity?.self ? 'saved' : d.isUser ? 'person' : d.isChannel && !d.isGroup ? 'channel' : 'group',
        unread: d.unreadCount || 0,
        preview: d.message ? messageText(d.message) : '',
        at: d.message?.date ? d.message.date * 1000 : null,
        entity: d.entity
      })
    }
    // Saved Messages is always reachable, as in Telegram Desktop, even when it isn't a recent chat.
    if (this.me && ![...next.values()].some((d) => d.kind === 'saved')) {
      try {
        const [last] = await this.client.getMessages('me', { limit: 1 })
        next.set(peerId(this.me.id), {
          id: peerId(this.me.id),
          name: 'Saved Messages',
          kind: 'saved',
          unread: 0,
          preview: last ? messageText(last) : '',
          at: last?.date ? last.date * 1000 : null,
          entity: await this.client.getInputEntity('me')
        })
      } catch {
        /* Saved Messages just won't be listed this time */
      }
    }
    this.dialogs = next
    this.emit('dialogs', this.dialogList())
  }

  dialogList() {
    return [...this.dialogs.values()].map(({ entity, ...rest }) => rest)
  }

  entity(id) {
    const d = this.dialogs.get(peerId(id))
    if (!d) throw new Error('That Telegram chat is not in your recent chats')
    return d.entity
  }

  async messages(id, { limit = 40, beforeId } = {}) {
    const list = await this.client.getMessages(this.entity(id), { limit: Math.min(limit, 100), offsetId: beforeId || 0 })
    return list
      .map((m) => ({
        id: m.id,
        from: senderName(m, this.me),
        text: messageText(m),
        caption: m.message || '',
        reactions: reactionList(m),
        media: mediaInfo(m),
        at: m.date * 1000,
        outgoing: Boolean(m.out)
      }))
      .reverse()
  }

  async message(id, msgId) {
    const [msg] = await this.client.getMessages(this.entity(id), { ids: [Number(msgId)] })
    if (!msg) throw new Error('That message is no longer available')
    return msg
  }

  // A picture to show in the conversation: the photo at a screen-friendly size, or a file's thumbnail.
  async preview(id, msgId) {
    const key = `${id}:${msgId}`
    if (this.previews.has(key)) return this.previews.get(key)
    const msg = await this.message(id, msgId)
    const info = mediaInfo(msg)
    let buf
    let type = 'image/jpeg'
    if (info?.kind === 'photo') {
      const sizes = msg.media.photo?.sizes || []
      const pick = ['x', 'm', 'y'].map((t) => sizes.findIndex((s) => s.type === t)).find((i) => i >= 0)
      buf = await this.client.downloadMedia(msg, { thumb: pick ?? sizes.length - 1 })
    } else if (info?.kind === 'sticker' && info.mime === 'image/webp') {
      buf = await this.client.downloadMedia(msg, {})
      type = 'image/webp'
    } else if (info?.preview) {
      buf = await this.client.downloadMedia(msg, { thumb: msg.media.document.thumbs.length - 1 })
    }
    const url = buf && Buffer.isBuffer(buf) ? `data:${type};base64,${buf.toString('base64')}` : null
    this.previews.set(key, url)
    if (this.previews.size > MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value)
    return url
  }

  // A voice message or audio file to play in IV Chat, loaded on demand into memory (not saved to disk).
  async audio(id, msgId) {
    const msg = await this.message(id, msgId)
    const info = mediaInfo(msg)
    if (!['voice', 'audio'].includes(info?.kind)) throw new Error('That message has no audio')
    if (info.size > MAX_AUDIO_BYTES) throw new Error('This audio is too large to play here. Use Save instead.')
    const buf = await this.client.downloadMedia(msg, {})
    if (!Buffer.isBuffer(buf)) throw new Error('The audio could not be loaded')
    const type = info.mime || (info.kind === 'voice' ? 'audio/ogg' : 'audio/mpeg')
    return `data:${type};base64,${buf.toString('base64')}`
  }

  // Saves the full photo or file to a place the person picked.
  async saveMedia(id, msgId, filePath) {
    const msg = await this.message(id, msgId)
    await this.client.downloadMedia(msg, { outputFile: filePath })
  }

  suggestedName(msg) {
    const info = mediaInfo(msg)
    if (info?.name) return info.name
    const ext = info?.kind === 'photo' ? 'jpg' : (info?.mime || '').split('/')[1]?.replace('quicktime', 'mov') || 'bin'
    return `telegram-${info?.kind || 'file'}-${msg.id}.${ext}`
  }

  async search(query, id) {
    const opts = { search: String(query), limit: 30 }
    const list = await this.client.getMessages(id ? this.entity(id) : undefined, opts)
    return list.map((m) => ({
      chat_id: peerId(m.chatId ?? m.peerId?.userId ?? ''),
      id: m.id,
      from: senderName(m, this.me),
      text: messageText(m),
      at: m.date * 1000
    }))
  }

  async onMessage(event) {
    const m = event.message
    const id = peerId(m.chatId)
    const d = this.dialogs.get(id)
    if (d) {
      d.preview = messageText(m)
      d.at = m.date * 1000
      if (!m.out) d.unread += 1
    } else {
      // A chat we haven't seen yet: reload the list so it has a name and can be used.
      this.refreshDialogs().catch(() => {})
    }
    if (!m.out) {
      this.updates.push({ chat_id: id, id: m.id, from: senderName(m, this.me), text: messageText(m), at: m.date * 1000 })
      if (this.updates.length > MAX_UPDATES) this.updates.splice(0, this.updates.length - MAX_UPDATES)
      this.emit('incoming', { chat_id: id, name: d?.name || '' })
    }
    this.emit('dialogs', this.dialogList())
    this.emit('message', id)
  }

  // ---------- writing ----------

  // Drafts appear in the reply box of every Telegram app the person uses. Nothing is sent.
  async saveDraft(id, text) {
    await this.client.invoke(new Api.messages.SaveDraft({ peer: this.entity(id), message: String(text) }))
  }

  // Called only from the IV Chat window when the person presses Enter or Send (see index.js).
  async sendFromPerson(id, text) {
    const message = String(text ?? '').trim()
    if (!message) return
    await this.client.sendMessage(this.entity(id), { message })
    // Clear any saved draft for that chat, the same as Telegram's own apps do after sending.
    await this.client.invoke(new Api.messages.SaveDraft({ peer: this.entity(id), message: '' })).catch(() => {})
  }

  // Called only from the IV Chat window when the person attaches a file and presses Send (see index.js).
  async sendFileFromPerson(id, filePath, caption) {
    await this.client.sendFile(this.entity(id), { file: filePath, caption: String(caption ?? '').slice(0, 1024), forceDocument: false })
    await this.client.invoke(new Api.messages.SaveDraft({ peer: this.entity(id), message: '' })).catch(() => {})
  }

  // Called only from the IV Chat window when the person clicks a reaction (see index.js).
  // One emoji sets your reaction on that message; null removes it.
  async reactFromPerson(id, msgId, emoji) {
    const reaction = emoji ? [new Api.ReactionEmoji({ emoticon: String(emoji) })] : []
    await this.client.invoke(new Api.messages.SendReaction({ peer: this.entity(id), msgId: Number(msgId), reaction, addToRecent: Boolean(emoji) }))
  }

  async markRead(id) {
    const d = this.dialogs.get(peerId(id))
    if (!d) return
    await this.client.markAsRead(d.entity).catch(() => {})
    d.unread = 0
    this.emit('dialogs', this.dialogList())
  }
}
