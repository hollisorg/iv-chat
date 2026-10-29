// Telegram, connected directly to the person's own account through Telegram's official user API (GramJS).
// Sign-in is by QR code from the Telegram app on their phone, plus their two-step password if they have one.
// The session is stored encrypted (secure-store). Sending happens only from the person's own keypress in the
// IV Chat window (see index.js); the AI side only ever reads and saves drafts.
import { EventEmitter } from 'node:events'
import bigInt from 'big-integer'
import QRCode from 'qrcode'
import { Api, TelegramClient, utils } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, Raw } from 'telegram/events/index.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { deleteSecret, readSecret, writeSecret } from './secure-store'
import { encodeWaveform } from './waveform.js'
import { actionText, dialogName, entityList, folderRules, inFolder, markupInfo, pollInfo, linkPreview, mediaInfo, messageText, personName, reactionList, senderName, serviceText, statusText } from './tg-format.js'

const KEYS = 'telegram-app'
const SESSION = 'telegram-session'
const MAX_UPDATES = 200
const MAX_PREVIEWS = 300
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const TYPING_MS = 6000

const peerId = (id) => String(id)

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
    this.avatars = new Map() // chat id -> Promise of a profile picture data URL (or null)
    this.found = new Map() // chat id -> entity, from New chat searches
    this.folders = []
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
    // Reactions, edits, deletions, pins and read receipts: tell the open conversation to refresh. Typing and
    // online status go to the conversation header.
    this.client.addEventHandler(
      (update) => this.onUpdate(update).catch(() => {}),
      new Raw({
        types: [
          Api.UpdateMessageReactions,
          Api.UpdateEditMessage,
          Api.UpdateEditChannelMessage,
          Api.UpdateDeleteMessages,
          Api.UpdateDeleteChannelMessages,
          Api.UpdatePinnedMessages,
          Api.UpdatePinnedChannelMessages,
          Api.UpdateReadHistoryOutbox,
          Api.UpdateReadChannelOutbox,
          Api.UpdateUserTyping,
          Api.UpdateChatUserTyping,
          Api.UpdateChannelUserTyping,
          Api.UpdateUserStatus,
          Api.UpdateDialogPinned,
          Api.UpdatePinnedDialogs,
          Api.UpdateFolderPeers,
          Api.UpdateNotifySettings,
          Api.UpdateDialogUnreadMark,
          Api.UpdateDialogFilter,
          Api.UpdateDialogFilters,
          Api.UpdateDialogFilterOrder,
          Api.UpdateMessagePoll
        ]
      })
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
    this.avatars.clear()
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
    // Your main chats and your archive together, the way Telegram returns them: pinned first, then newest.
    const list = await this.client.getDialogs({ limit: 150 })
    // Built off to the side and swapped in at the end, so chats never vanish mid-refresh.
    const next = new Map()
    const now = Date.now() / 1000
    list.forEach((d, order) => {
      const muteUntil = d.dialog?.notifySettings?.muteUntil || 0
      next.set(peerId(d.id), {
        id: peerId(d.id),
        // Your own chat is "Saved Messages", as in Telegram's apps.
        name: d.entity?.self ? 'Saved Messages' : dialogName(d),
        kind: d.entity?.self ? 'saved' : d.isUser ? 'person' : d.isChannel && !d.isGroup ? 'channel' : 'group',
        unread: d.unreadCount || 0,
        unreadMark: Boolean(d.dialog?.unreadMark),
        mentions: d.dialog?.unreadMentionsCount || 0,
        preview: d.message ? messageText(d.message) : '',
        at: d.message?.date ? d.message.date * 1000 : null,
        pinned: Boolean(d.pinned),
        order,
        archived: Boolean(d.archived),
        muted: muteUntil > now,
        muteUntil: muteUntil > now ? muteUntil * 1000 : 0,
        bot: Boolean(d.entity?.bot),
        contact: Boolean(d.entity?.contact),
        username: d.entity?.username || d.entity?.usernames?.find((u) => u.active)?.username || '',
        // Your messages up to this id have been read by the other side (for the double tick).
        readOut: d.dialog?.readOutboxMaxId || 0,
        entity: d.entity
      })
    })
    // Chats opened from search that don't have messages yet stay reachable until the next restart.
    for (const [id, d] of this.dialogs) if (d.found && !next.has(id)) next.set(id, d)
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
    await this.refreshFolders()
    this.emit('dialogs', this.dialogList())
  }

  dialogList() {
    return [...this.dialogs.values()].map(({ entity, ...rest }) => rest)
  }

  // Your Telegram folders ("Work", "Family"…) with the chats in each, worked out from the folder's rules.
  async refreshFolders() {
    try {
      const res = await this.client.invoke(new Api.messages.GetDialogFilters())
      const filters = (res.filters || res || []).filter((f) => f.className === 'DialogFilter' || f.className === 'DialogFilterChatlist')
      this.folders = filters.map((f) => {
        const rules = folderRules(f, (p) => utils.getPeerId(p))
        const ids = [...this.dialogs.values()].filter((d) => inFolder(rules, d)).map((d) => d.id)
        return { id: rules.id, title: rules.title, emoticon: rules.emoticon, pinned: rules.pinned, ids }
      })
    } catch {
      this.folders = this.folders || []
    }
    this.emit('folders', this.folders)
  }

  folderList() {
    return this.folders || []
  }

  // A refresh after something about the chat list changed (pinned, muted, archived, folders), coalesced so a
  // burst of updates costs one reload.
  softRefresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => this.refreshDialogs().catch(() => {}), 600)
  }

  entity(id) {
    const d = this.dialogs.get(peerId(id))
    if (!d) throw new Error('That Telegram chat is not in your recent chats')
    return d.entity
  }

  // A page of messages, oldest first: the latest ones, the ones before `beforeId`, or the ones around
  // `aroundId` (for jumping to a search result or a replied-to message).
  async messages(id, { limit = 40, beforeId, aroundId } = {}) {
    const entity = this.entity(id)
    const opts = { limit: Math.min(limit, 100) }
    if (aroundId) Object.assign(opts, { offsetId: Number(aroundId) + 1, addOffset: -Math.floor(opts.limit / 2) })
    else if (beforeId) opts.offsetId = Number(beforeId)
    const list = await this.client.getMessages(entity, opts)
    // Replies show a quote of the message they answer; fetch the ones not already on this page.
    const here = new Map(list.map((m) => [m.id, m]))
    const wanted = [...new Set(list.filter((m) => m.replyTo?.replyToMsgId && !m.replyTo.replyToPeerId && !here.has(m.replyTo.replyToMsgId)).map((m) => m.replyTo.replyToMsgId))]
    if (wanted.length) {
      try {
        for (const m of await this.client.getMessages(entity, { ids: wanted })) if (m) here.set(m.id, m)
      } catch {
        /* quotes just won't show */
      }
    }
    const d = this.dialogs.get(peerId(id))
    return list
      .map((m) => this.item(m, here, d))
      .sort((a, b) => a.id - b.id)
  }

  // One message in the shape the window draws.
  item(m, others, d) {
    const reply = m.replyTo?.replyToMsgId && !m.replyTo.replyToPeerId ? others?.get(m.replyTo.replyToMsgId) : null
    const fwd = m.fwdFrom
    return {
      id: m.id,
      from: senderName(m, this.me),
      fromId: m.senderId ? String(m.senderId) : null,
      text: messageText(m),
      body: m.message || '',
      entities: entityList(m),
      caption: m.message || '',
      reactions: reactionList(m),
      media: mediaInfo(m),
      link: linkPreview(m),
      poll: pollInfo(m),
      buttons: markupInfo(m),
      fromBot: Boolean(m.sender?.bot || m.viaBotId),
      scheduled: Boolean(m.fromScheduled && m.date * 1000 > Date.now()),
      silent: Boolean(m.silent),
      service: m.action ? serviceText(m) : null,
      reply: m.replyTo?.replyToMsgId
        ? reply
          ? { id: reply.id, from: senderName(reply, this.me) || personName(reply.sender), text: messageText(reply) }
          : { id: m.replyTo.replyToMsgId, from: '', text: 'Message' }
        : null,
      forwarded: fwd ? personName(m.forward?.sender) || personName(m.forward?.chat) || fwd.fromName || 'someone' : null,
      edited: Boolean(m.editDate && !m.editHide),
      pinned: Boolean(m.pinned),
      album: m.groupedId ? String(m.groupedId) : null,
      at: m.date * 1000,
      // Telegram doesn't mark what you write in Saved Messages as outgoing; IV Chat treats it as yours, as
      // Telegram's own apps do (forwarded items stay on the other side).
      outgoing: Boolean(m.out || (d?.kind === 'saved' && !m.fwdFrom)),
      // Sent and read ticks for your own messages. Saved Messages counts as read.
      read: Boolean((m.out && d?.readOut && m.id <= d.readOut) || (d?.kind === 'saved' && !m.fwdFrom))
    }
  }

  // The header line for a chat: online or last seen for a person, the member count for a group or channel.
  async chatInfo(id) {
    const d = this.dialogs.get(peerId(id))
    if (!d) return {}
    if (d.kind === 'saved') return { subtitle: 'your notes and saved messages' }
    if (d.kind === 'person') return { subtitle: d.entity?.bot ? 'bot' : statusText(d.entity?.status) }
    const count = d.entity?.participantsCount
    const word = d.kind === 'channel' ? 'subscriber' : 'member'
    return { subtitle: count ? `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}` : d.kind }
  }

  // A chat's small profile picture (a person's photo, or a group's or channel's), loaded once and kept in
  // memory. Null when there's none; the window then draws initials.
  avatar(id) {
    const key = peerId(id)
    if (!this.avatars.has(key)) {
      const d = this.dialogs.get(key)
      // Chats from search results have their picture too, before they're opened.
      const entity = d?.entity || this.found.get(key)
      if (!entity) return Promise.resolve(null)
      const photo = entity.photo
      const load =
        d?.kind === 'saved' || entity.self || !photo || /Empty$/.test(photo.className || '')
          ? Promise.resolve(null)
          : this.client
              .downloadProfilePhoto(entity, { isBig: false })
              .then((buf) => (Buffer.isBuffer(buf) && buf.length ? `data:image/jpeg;base64,${buf.toString('base64')}` : null))
              .catch(() => null)
      this.avatars.set(key, load)
    }
    return this.avatars.get(key)
  }

  // ---------- the chat list: pin, mute, archive, unread ----------
  // Each is called only from the person's own click in the IV Chat window (see index.js).

  async pinChatFromPerson(id, pinned) {
    await this.client.invoke(new Api.messages.ToggleDialogPin({ peer: new Api.InputDialogPeer({ peer: this.entity(id) }), pinned: Boolean(pinned) }))
    this.softRefresh()
  }

  // `until` is a time in milliseconds, 0 to unmute, or Infinity for "until I turn it back on".
  async muteFromPerson(id, until) {
    const muteUntil = until === 0 ? 0 : !Number.isFinite(until) ? 2147483647 : Math.floor(until / 1000)
    await this.client.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer: this.entity(id) }), settings: new Api.InputPeerNotifySettings({ muteUntil }) }))
    this.softRefresh()
  }

  async archiveFromPerson(id, archived) {
    await this.client.invoke(new Api.folders.EditPeerFolders({ folderPeers: [new Api.InputFolderPeer({ peer: this.entity(id), folderId: archived ? 1 : 0 })] }))
    this.softRefresh()
  }

  async markUnreadFromPerson(id, unread) {
    const d = this.dialogs.get(peerId(id))
    if (!unread) {
      await this.markRead(id)
      if (d?.unreadMark) await this.client.invoke(new Api.messages.MarkDialogUnread({ peer: new Api.InputDialogPeer({ peer: this.entity(id) }), unread: false }))
    } else {
      await this.client.invoke(new Api.messages.MarkDialogUnread({ peer: new Api.InputDialogPeer({ peer: this.entity(id) }), unread: true }))
    }
    if (d) d.unreadMark = Boolean(unread)
    this.emit('dialogs', this.dialogList())
  }

  // ---------- finding people and chats ----------

  // Your contacts and public people, groups and channels matching a name or @username (for New chat).
  async findChats(query) {
    const q = String(query || '').trim().replace(/^@/, '')
    if (q.length < 2) return []
    const res = await this.client.invoke(new Api.contacts.Search({ q, limit: 30 }))
    const mine = new Set([...(res.myResults || [])].map((p) => peerId(utils.getPeerId(p))))
    const out = []
    for (const e of [...(res.users || []), ...(res.chats || [])]) {
      if (e.className === 'ChatForbidden' || e.className === 'ChannelForbidden' || e.deleted) continue
      const id = peerId(utils.getPeerId(e))
      this.found.set(id, e)
      const kind = e.className === 'User' ? (e.self ? 'saved' : 'person') : e.className === 'Channel' && e.broadcast ? 'channel' : 'group'
      out.push({ id, name: e.self ? 'Saved Messages' : personName(e), kind, username: e.username || '', mine: mine.has(id) || Boolean(e.contact), members: e.participantsCount || 0, open: this.dialogs.has(id) })
    }
    // Your own contacts and chats first.
    return out.sort((a, b) => Number(b.mine) - Number(a.mine))
  }

  // Makes a chat found by search available to open, even before it has any messages.
  openFound(id) {
    const key = peerId(id)
    if (this.dialogs.has(key)) return this.dialogs.get(key).id
    const e = this.found.get(key)
    if (!e) throw new Error('Search again to open that chat')
    const kind = e.className === 'User' ? 'person' : e.className === 'Channel' && e.broadcast ? 'channel' : 'group'
    this.dialogs.set(key, { id: key, name: personName(e), kind, unread: 0, preview: '', at: null, pinned: false, archived: false, muted: false, bot: Boolean(e.bot), contact: Boolean(e.contact), username: e.username || '', readOut: 0, found: true, entity: e })
    this.emit('dialogs', this.dialogList())
    return key
  }

  // ---------- the chat info panel ----------

  // Everything the info panel shows about a chat: its about text, @username, phone (for your contacts),
  // member count, and how many photos, videos, files, links and voice messages it has.
  async chatDetails(id) {
    const d = this.dialogs.get(peerId(id))
    if (!d) return null
    const entity = d.entity
    // `found`: opened from search and not one of your chats, so pin, mute and archive don't apply.
    const out = { id: d.id, name: d.name, kind: d.kind, username: d.username, muted: d.muted, muteUntil: d.muteUntil, pinned: d.pinned, archived: d.archived, found: Boolean(d.found) }
    try {
      if (d.kind === 'person' || d.kind === 'saved') {
        const full = await this.client.invoke(new Api.users.GetFullUser({ id: entity }))
        out.about = full.fullUser?.about || ''
        const u = full.users?.[0]
        if (u?.phone && d.kind !== 'saved') out.phone = `+${u.phone}`
        out.subtitle = (await this.chatInfo(id)).subtitle
      } else if (entity.className === 'Channel') {
        const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity }))
        out.about = full.fullChat?.about || ''
        out.members = full.fullChat?.participantsCount || entity.participantsCount || 0
        out.online = full.fullChat?.onlineCount || 0
      } else {
        const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))
        out.about = full.fullChat?.about || ''
        out.members = full.fullChat?.participants?.participants?.length || entity.participantsCount || 0
      }
    } catch {
      /* the panel shows what it has */
    }
    try {
      const kinds = [new Api.InputMessagesFilterPhotoVideo(), new Api.InputMessagesFilterDocument(), new Api.InputMessagesFilterUrl(), new Api.InputMessagesFilterRoundVoice()]
      const counts = await this.client.invoke(new Api.messages.GetSearchCounters({ peer: entity, filters: kinds }))
      const [media, files, links, voice] = counts.map((c) => c.count || 0)
      out.counts = { media, files, links, voice }
    } catch {
      out.counts = null
    }
    return out
  }

  // A page of a chat's shared photos and videos, files, links or voice messages, newest first.
  async sharedMedia(id, kind, beforeId) {
    const filter = {
      media: new Api.InputMessagesFilterPhotoVideo(),
      files: new Api.InputMessagesFilterDocument(),
      links: new Api.InputMessagesFilterUrl(),
      voice: new Api.InputMessagesFilterRoundVoice()
    }[kind]
    if (!filter) throw new Error('Unknown kind of shared media')
    const list = await this.client.getMessages(this.entity(id), { limit: 40, filter, offsetId: Number(beforeId) || 0 })
    const d = this.dialogs.get(peerId(id))
    return list.map((m) => this.item(m, null, d))
  }

  // The most recent pinned message in a chat, for the bar at the top of the conversation.
  async pinned(id) {
    try {
      const [m] = await this.client.getMessages(this.entity(id), { limit: 1, filter: new Api.InputMessagesFilterPinned() })
      return m ? { id: m.id, text: messageText(m) } : null
    } catch {
      return null
    }
  }

  // Updates other than new messages. Each one either refreshes a chat, or reports typing or online status.
  async onUpdate(u) {
    const channel = (channelId) => peerId(utils.getPeerId(new Api.PeerChannel({ channelId })))
    switch (u.className) {
      case 'UpdateReadHistoryOutbox': {
        const id = peerId(utils.getPeerId(u.peer))
        const d = this.dialogs.get(id)
        if (d) d.readOut = Math.max(d.readOut || 0, u.maxId)
        return this.emit('message', id)
      }
      case 'UpdateReadChannelOutbox': {
        const id = channel(u.channelId)
        const d = this.dialogs.get(id)
        if (d) d.readOut = Math.max(d.readOut || 0, u.maxId)
        return this.emit('message', id)
      }
      case 'UpdateEditMessage':
      case 'UpdateEditChannelMessage':
        return this.emit('message', peerId(utils.getPeerId(u.message.peerId)))
      case 'UpdateDeleteChannelMessages':
      case 'UpdatePinnedChannelMessages':
        return this.emit('message', channel(u.channelId))
      case 'UpdateMessagePoll':
        // New votes on a poll don't say which chat; the open one checks itself.
      case 'UpdateDeleteMessages':
        // Private and small-group deletions don't say which chat; the open one checks itself.
        return this.emit('message', '*')
      case 'UpdatePinnedMessages':
      case 'UpdateMessageReactions':
        return this.emit('message', peerId(utils.getPeerId(u.peer)))
      case 'UpdateUserStatus': {
        const d = this.dialogs.get(peerId(u.userId))
        if (d?.entity) d.entity.status = u.status
        return this.emit('status', peerId(u.userId))
      }
      case 'UpdateUserTyping':
      case 'UpdateChatUserTyping':
      case 'UpdateChannelUserTyping': {
        const text = actionText(u.action)
        const chatId =
          u.className === 'UpdateUserTyping' ? peerId(u.userId) : u.className === 'UpdateChatUserTyping' ? peerId(utils.getPeerId(new Api.PeerChat({ chatId: u.chatId }))) : channel(u.channelId)
        let name = ''
        if (u.className !== 'UpdateUserTyping' && u.fromId) {
          try {
            name = personName(await this.client.getEntity(u.fromId)).split(' ')[0]
          } catch {
            /* "someone is typing" */
          }
        }
        return this.emit('typing', { chatId, text: text ? (name ? `${name} is ${text}` : text) : null, until: text ? Date.now() + TYPING_MS : 0 })
      }
      case 'UpdateDialogPinned':
      case 'UpdatePinnedDialogs':
      case 'UpdateFolderPeers':
      case 'UpdateNotifySettings':
      case 'UpdateDialogUnreadMark':
      case 'UpdateDialogFilter':
      case 'UpdateDialogFilters':
      case 'UpdateDialogFilterOrder':
        // Something about the chat list changed, here or in another Telegram app.
        return this.softRefresh()
      default:
    }
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
    const webPhoto = msg.media?.className === 'MessageMediaWebPage' ? msg.media.webpage?.photo : null
    if (info?.kind === 'photo' || webPhoto) {
      // A link preview's picture is a photo too; downloadMedia picks it out of the page.
      const sizes = (webPhoto || msg.media.photo)?.sizes || []
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

  // The full file behind a video, GIF, sticker or photo, for the in-app player and photo viewer (tg-media.js).
  // Photos come as a whole buffer (they're small); documents stream through the writer as they download.
  async mediaSource(id, msgId) {
    const msg = await this.message(id, msgId)
    const info = mediaInfo(msg)
    if (!info || info.kind === 'other') throw new Error('That message has nothing to play')
    if (info.kind === 'photo') {
      const buf = await this.client.downloadMedia(msg, {})
      if (!Buffer.isBuffer(buf)) throw new Error('The photo could not be loaded')
      return { size: buf.length, mime: 'image/jpeg', download: async (writer) => writer.write(buf) }
    }
    return {
      size: info.size,
      mime: info.mime || 'application/octet-stream',
      download: (writer) => this.client.downloadMedia(msg, { outputFile: writer }),
      // Chunks from any point in the file, for seeking ahead of the download. `offset` is a multiple of 512 KB.
      readFrom: (offset) => this.client.iterDownload({ file: msg.media, offset: bigInt(offset), requestSize: 512 * 1024, fileSize: bigInt(info.size) })
    }
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
      // Muted and archived chats don't notify, as in Telegram.
      const quiet = d?.muted || d?.archived
      this.updates.push({ chat_id: id, id: m.id, from: senderName(m, this.me), text: messageText(m), at: m.date * 1000 })
      if (this.updates.length > MAX_UPDATES) this.updates.splice(0, this.updates.length - MAX_UPDATES)
      if (!quiet) this.emit('incoming', { chat_id: id, name: d?.name || '' })
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
  // `replyTo` quotes one of the chat's messages, as Telegram's Reply does.
  // `silent` sends without a notification sound; `schedule` (a time in milliseconds) sends it later.
  async sendFromPerson(id, text, { replyTo, silent, schedule } = {}) {
    const message = String(text ?? '').trim()
    if (!message) return
    await this.client.sendMessage(this.entity(id), { message, replyTo: replyTo ? Number(replyTo) : undefined, silent: Boolean(silent), schedule: schedule ? Math.floor(schedule / 1000) : undefined })
    // Clear any saved draft for that chat, the same as Telegram's own apps do after sending.
    await this.client.invoke(new Api.messages.SaveDraft({ peer: this.entity(id), message: '' })).catch(() => {})
  }

  // Called only from the IV Chat window when the person attaches a file and presses Send (see index.js).
  async sendFileFromPerson(id, filePath, caption, { replyTo, silent, schedule } = {}) {
    await this.client.sendFile(this.entity(id), { file: filePath, caption: String(caption ?? '').slice(0, 1024), forceDocument: false, replyTo: replyTo ? Number(replyTo) : undefined, silent: Boolean(silent), scheduleDate: schedule ? Math.floor(schedule / 1000) : undefined })
    await this.client.invoke(new Api.messages.SaveDraft({ peer: this.entity(id), message: '' })).catch(() => {})
  }

  // A voice message the person recorded and sent from the IV Chat window (see index.js): OGG Opus with its
  // length and waveform, so it shows as a voice note with bars in every Telegram app.
  async sendVoiceFromPerson(id, filePath, { seconds, waveform, replyTo } = {}) {
    await this.client.sendFile(this.entity(id), {
      file: filePath,
      voiceNote: true,
      attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: Math.max(1, Math.round(seconds || 0)), waveform: Buffer.from(encodeWaveform(waveform || [])) })],
      replyTo: replyTo ? Number(replyTo) : undefined
    })
    await this.client.invoke(new Api.messages.SaveDraft({ peer: this.entity(id), message: '' })).catch(() => {})
  }

  // ---------- polls, bot buttons, scheduled messages, translation ----------
  // Voting, sending and pressing bot buttons come only from the person's own clicks (see index.js).

  // `options` are the chosen answers (base64 as the window has them); none takes your vote back.
  async voteFromPerson(id, msgId, options) {
    await this.client.invoke(new Api.messages.SendVote({ peer: this.entity(id), msgId: Number(msgId), options: options.map((o) => Buffer.from(String(o), 'base64')) }))
  }

  async sendPollFromPerson(id, { question, answers, multiple, quiz, correct, anonymous }, { replyTo, silent, schedule } = {}) {
    const text = (t) => new Api.TextWithEntities({ text: String(t).slice(0, 300), entities: [] })
    const list = answers.map((a) => String(a).trim()).filter(Boolean).slice(0, 10)
    if (!String(question || '').trim() || list.length < 2) throw new Error('A poll needs a question and at least two answers')
    const poll = new Api.Poll({
      id: bigInt(Math.floor(Math.random() * 2 ** 52)),
      question: text(question),
      answers: list.map((a, i) => new Api.PollAnswer({ text: text(a), option: Buffer.from([i]) })),
      multipleChoice: Boolean(multiple) && !quiz,
      quiz: Boolean(quiz),
      publicVoters: anonymous === false
    })
    const media = new Api.InputMediaPoll({ poll, correctAnswers: quiz ? [Buffer.from([Math.max(0, Math.min(list.length - 1, Number(correct) || 0))])] : undefined })
    await this.client.invoke(
      new Api.messages.SendMedia({
        peer: this.entity(id),
        media,
        message: '',
        randomId: bigInt(Math.floor(Math.random() * 2 ** 52)),
        replyTo: replyTo ? new Api.InputReplyToMessage({ replyToMsgId: Number(replyTo) }) : undefined,
        silent: Boolean(silent),
        scheduleDate: schedule ? Math.floor(schedule / 1000) : undefined
      })
    )
  }

  // A bot's button under one of its messages. The bot can answer with a note, an alert or a link.
  async pressButtonFromPerson(id, msgId, data, game) {
    const res = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: this.entity(id), msgId: Number(msgId), data: game ? undefined : Buffer.from(String(data || ''), 'base64'), game: Boolean(game) }))
    return { message: res.message || '', alert: Boolean(res.alert), url: res.url || '' }
  }

  // Messages waiting to be sent later in a chat.
  async scheduled(id) {
    const res = await this.client.invoke(new Api.messages.GetScheduledHistory({ peer: this.entity(id), hash: bigInt(0) }))
    const d = this.dialogs.get(peerId(id))
    return (res.messages || []).filter((m) => m.className === 'Message').map((m) => ({ ...this.item(m, null, d), outgoing: true })).sort((a, b) => a.at - b.at)
  }

  async sendScheduledNowFromPerson(id, msgIds) {
    await this.client.invoke(new Api.messages.SendScheduledMessages({ peer: this.entity(id), id: msgIds.map(Number) }))
  }

  async deleteScheduledFromPerson(id, msgIds) {
    await this.client.invoke(new Api.messages.DeleteScheduledMessages({ peer: this.entity(id), id: msgIds.map(Number) }))
  }

  // Telegram's own translation of messages into `toLang` (like "en").
  async translate(id, msgIds, toLang) {
    const res = await this.client.invoke(new Api.messages.TranslateText({ peer: this.entity(id), id: msgIds.map(Number), toLang: String(toLang || 'en').slice(0, 8) }))
    return (res.result || []).map((r) => r.text || '')
  }

  // The rest are also accepted only from the person's own clicks in the IV Chat window (see index.js).
  async editFromPerson(id, msgId, text) {
    const message = String(text ?? '').trim()
    if (!message) throw new Error('A message needs some text')
    await this.client.editMessage(this.entity(id), { message: Number(msgId), text: message })
  }

  // `everyone` deletes it for the other people in the chat too, where Telegram allows that.
  async deleteFromPerson(id, msgIds, everyone) {
    await this.client.deleteMessages(this.entity(id), msgIds.map(Number), { revoke: Boolean(everyone) })
  }

  async forwardFromPerson(fromId, msgIds, toId) {
    await this.client.forwardMessages(this.entity(toId), { messages: msgIds.map(Number), fromPeer: this.entity(fromId) })
  }

  async pinFromPerson(id, msgId, unpin) {
    if (unpin) await this.client.unpinMessage(this.entity(id), Number(msgId))
    else await this.client.pinMessage(this.entity(id), Number(msgId), { notify: false })
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
